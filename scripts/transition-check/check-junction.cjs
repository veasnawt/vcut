// Optional isolated React UI check. Uses the built mobile CSS and no user project data.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const esbuild = require(process.env.ESBUILD_MODULE || 'esbuild');
const root = path.resolve(__dirname, '../..');
(async () => {
  const bundle = await esbuild.build({stdin:{contents:`
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {TransitionJunction} from './src/ui/TransitionJunction.tsx';
    window.check={changes:[],opens:0,bubbled:0};
    function App(){const [duration,setDuration]=useState(0.8);const [mobile,setMobile]=useState(false);
      window.setMobile=setMobile;
      return <div style={{padding:32,color:'white',fontFamily:'sans-serif'}}>
        <div style={{fontSize:18,marginBottom:24}}>Transition between clips</div>
        <div onMouseDown={()=>window.check.bubbled++} style={{position:'relative',height:52,width:560}}>
          <div style={{position:'absolute',left:0,width:280,top:4,bottom:4,background:'#425776',borderRadius:6,padding:5,fontSize:11}}>First clip</div>
          <div style={{position:'absolute',left:280,width:280,top:4,bottom:4,background:'#644658',borderRadius:6,padding:5,fontSize:11}}>Next clip</div>
          <TransitionJunction cut={280} duration={duration} maxDuration={2} pixelsPerSecond={100} fps={30}
            mobile={mobile} locked={false} label='Change transition' durationLabel='Adjust transition duration'
            onOpen={()=>window.check.opens++} onDurationChange={d=>{window.check.changes.push(d);setDuration(d);}}/>
        </div>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `,resolveDir:root,loader:'tsx'},bundle:true,format:'iife',platform:'browser',write:false});
  const cssDir=path.resolve(root,'../../apps/mobile/dist/assets');
  const css=fs.readFileSync(path.join(cssDir,fs.readdirSync(cssDir).find(f=>f.endsWith('.css'))),'utf8');
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
  try {
    const context=await browser.newContext({viewport:{width:680,height:230},hasTouch:true});
    const page=await context.newPage();
    await page.setContent('<html><body style="margin:0;background:#12151c"><div id="root"></div></body></html>');
    await page.addStyleTag({content:css}); await page.addScriptTag({content:bundle.outputFiles[0].text});
    const junction=page.locator('[data-transition-junction]'); await junction.waitFor();
    const centered=async()=>{const box=await junction.boundingBox();assert.ok(Math.abs(box.x+box.width/2-312)<1);};
    await centered();
    await page.getByRole('button',{name:'Change transition'}).click();
    assert.equal(await page.evaluate(()=>window.check.opens),1);
    const right=page.locator('[data-transition-handle="right"]');
    let box=await right.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down();
    await page.mouse.move(box.x+box.width/2+20,box.y+box.height/2,{steps:5});
    assert.equal(await page.evaluate(()=>window.check.changes.length),0,'drag should not create undo entries before release');
    await page.mouse.up();
    assert.equal(await page.evaluate(()=>window.check.changes.length),1); await centered();
    assert.ok(Math.abs(await page.evaluate(()=>window.check.changes[0])-1.2)<0.001);
    await right.focus(); await page.keyboard.press('ArrowLeft');
    assert.ok(Math.abs(await page.evaluate(()=>window.check.changes.at(-1))-35/30)<0.001);
    const before=await page.evaluate(()=>window.check.changes.length);
    box=await right.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    await page.mouse.move(box.x+box.width/2+15,box.y+box.height/2);
    await right.dispatchEvent('pointercancel',{pointerId:1});await page.mouse.up();
    assert.equal(await page.evaluate(()=>window.check.changes.length),before,'cancel must not commit');
    await centered();
    const desktop=path.join(os.tmpdir(),'vcut-junction-desktop.png'); await page.screenshot({path:desktop});
    await page.evaluate(()=>window.setMobile(true));
    await page.waitForTimeout(50);box=await right.boundingBox();
    const cdp=await context.newCDPSession(page);
    const x=box.x+box.width/2,y=box.y+box.height/2;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+15,y}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert.equal(await page.evaluate(()=>window.check.changes.length),before+1,'touch drag commits once');
    assert.equal(await page.evaluate(()=>window.check.bubbled),0,'junction must not start clip drag');
    await centered();
    const mobile=path.join(os.tmpdir(),'vcut-junction-touch.png');await page.screenshot({path:mobile});
    console.log(JSON.stringify({result:'PASS: centered geometry, picker tap, mouse/touch duration drag, keyboard, cancel, event isolation',desktop,mobile}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
