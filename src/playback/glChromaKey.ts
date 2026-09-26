import type { ChromaKeySettings } from "../project/types.ts";
import { SLICE_GLITCH_COUNT, sliceGlitchStrips } from "../timeline/pixelEffects.ts";

/** A key that keys nothing, for a clip that only needs the GPU for its Slice Glitch. */
const NO_KEY: ChromaKeySettings = { color: "#000000", similarity: -1, smoothness: 0, despill: 0 };

/** Chroma key on the GPU. The CPU keyer (`applyChromaKey`) has to copy every video frame out of the graphics card, loop over
 *  ~1M pixels in JavaScript and copy it back — far too slow on a phone or tablet to keep up with video, which is what made a
 *  cutout stutter. This does the same maths in a fragment shader: the frame is uploaded as a texture and drawn keyed, nothing is
 *  read back, and the result is a canvas that `drawImage` takes like any other source.
 *
 *  Same rules as `applyChromaKey`: RGB distance from the key colour scaled to 0..1, fully clear at or under `similarity`, a
 *  linear ramp across `smoothness`, and (for a green-ish key with `despill`) green pulled down toward red/blue on the kept
 *  pixels. One shared instance draws one frame at a time; the returned canvas is only valid until the next `render`.
 *
 *  Slice Glitch (thin strips jumping sideways) runs here too, so a glitching cutout or collage cell needs no readback either: the
 *  strips come from the same `sliceGlitchStrips` the CPU effect uses. */
export class GlChromaKeyer {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private failed = false;

  /** False on a browser without WebGL, or after a context loss — callers then use the CPU keyer. */
  get available(): boolean {
    return !this.failed;
  }

  private init(): boolean {
    if (this.gl) return true;
    if (this.failed || typeof document === "undefined") return false;
    try {
      const canvas = document.createElement("canvas");
      const gl = (canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true, depth: false, stencil: false }) ??
        canvas.getContext("experimental-webgl", { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true })) as WebGLRenderingContext | null;
      if (!gl) throw new Error("no webgl");
      const compile = (type: number, source: string) => {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader");
        return shader;
      };
      const program = gl.createProgram()!;
      gl.attachShader(
        program,
        compile(gl.VERTEX_SHADER, "attribute vec2 p;varying vec2 v;void main(){v=vec2(p.x*0.5+0.5,0.5-p.y*0.5);gl_Position=vec4(p,0.0,1.0);}")
      );
      gl.attachShader(
        program,
        compile(
          gl.FRAGMENT_SHADER,
          `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v;
uniform sampler2D tex;
uniform vec3 key;
uniform float similarity;
uniform float smoothness;
uniform float despill;
uniform vec2 dims;
uniform float stripCount;
uniform vec3 strips[%COUNT%];
void main(){
  // Slice Glitch: a pixel inside a strip reads from shift pixels along its row; the last strip covering it wins.
  float px = floor(v.x * dims.x);
  float py = floor(v.y * dims.y);
  float sx = px;
  for (int i = 0; i < %COUNT%; i++) {
    if (float(i) >= stripCount) break;
    vec3 s = strips[i];
    if (py >= s.x && py < s.x + s.y) sx = clamp(px + s.z, 0.0, dims.x - 1.0);
  }
  vec4 c = texture2D(tex, vec2((sx + 0.5) / dims.x, v.y));
  float d = distance(c.rgb, key) / 1.7320508;
  float a;
  if (d <= similarity) a = 0.0;
  else if (smoothness > 0.0 && d < similarity + smoothness) a = (d - similarity) / smoothness;
  else a = 1.0;
  vec3 rgb = c.rgb;
  if (a > 0.0 && despill > 0.0) {
    float lead = rgb.g - max(rgb.r, rgb.b);
    if (lead > 0.0) rgb.g -= lead * despill;
  }
  a *= c.a;
  gl_FragColor = vec4(rgb * a, a);
}`.replaceAll("%COUNT%", String(SLICE_GLITCH_COUNT))
        )
      );
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("link");
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.useProgram(program);
      const location = gl.getAttribLocation(program, "p");
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        this.failed = true;
      });
      this.canvas = canvas;
      this.gl = gl;
      this.program = program;
      this.texture = texture;
      for (const name of ["tex", "key", "similarity", "smoothness", "despill", "dims", "stripCount", "strips[0]"]) this.uniforms[name] = gl.getUniformLocation(program, name);
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }

  /** Keys `source` (a video or image) into a canvas of `width × height`, with Slice Glitch applied when `glitch` is given.
   *  Pass `settings` as `null` for a clip that has no key (it then only needs the glitch). Returns the canvas, or `null` if the
   *  GPU path isn't usable (then use the CPU path). */
  render(
    source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
    width: number,
    height: number,
    keySettings: ChromaKeySettings | null,
    glitch?: { elapsedSeconds: number; speed: number }
  ): HTMLCanvasElement | null {
    const settings = keySettings ?? NO_KEY;
    if (!this.init() || !this.gl || !this.canvas) return null;
    const gl = this.gl;
    try {
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      const keyR = parseInt(settings.color.slice(1, 3), 16) / 255;
      const keyG = parseInt(settings.color.slice(3, 5), 16) / 255;
      const keyB = parseInt(settings.color.slice(5, 7), 16) / 255;
      gl.uniform1i(this.uniforms.tex, 0);
      gl.uniform3f(this.uniforms.key, keyR, keyG, keyB);
      gl.uniform1f(this.uniforms.similarity, settings.similarity);
      gl.uniform1f(this.uniforms.smoothness, settings.smoothness);
      gl.uniform1f(this.uniforms.despill, keyG >= Math.max(keyR, keyB) ? (settings.despill ?? 0) : 0);
      const strips = glitch ? sliceGlitchStrips(glitch.elapsedSeconds, glitch.speed, width, height) : [];
      const packed = new Float32Array(SLICE_GLITCH_COUNT * 3);
      strips.forEach((strip, i) => packed.set([strip.top, strip.rows, strip.shift], i * 3));
      gl.uniform2f(this.uniforms.dims, width, height);
      gl.uniform1f(this.uniforms.stripCount, strips.length);
      gl.uniform3fv(this.uniforms["strips[0]"], packed);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return this.failed ? null : this.canvas;
    } catch {
      this.failed = true;
      return null;
    }
  }
}
