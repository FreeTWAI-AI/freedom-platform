import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {test,expect} from './fixtures.js';

// Exercise real React layout-effect setup/cleanup with the production aggregate.
// No platform data or product bypass endpoint is used by this local browser fixture.
test('chat leave guards AND-compose and one child cleanup cannot release a sibling',async({page})=>{
  const script=buildSync({stdin:{resolveDir:fileURLToPath(new URL('../..',import.meta.url)),loader:'tsx',contents:`
    import React,{useLayoutEffect,useRef,useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useChatLeaveGuards} from './apps/portal-web/src/modules/chat-leave-guards';
    function Child({name,register}){
      const pending=useRef(false);
      useLayoutEffect(()=>{register(()=>!pending.current);return()=>register(null);},[register]);
      return <div><button onClick={()=>{pending.current=true;}}>Start {name}</button><button onClick={()=>{pending.current=false;}}>Confirm {name}</button></div>;
    }
    function Fixture(){
      const parent=useRef(null),register=useRef(guard=>{parent.current=guard;}),guards=useChatLeaveGuards(register.current);
      const [direct,setDirect]=useState(true),[guild,setGuild]=useState(true),[result,setResult]=useState('');
      return <><button onClick={()=>setDirect(value=>!value)}>Toggle direct</button><button onClick={()=>setGuild(value=>!value)}>Toggle guild</button>
        <button onClick={()=>setResult(parent.current()?'allowed':'blocked')}>Leave</button><output>{result}</output>
        {direct&&<Child name="direct" register={guards.direct}/>}{guild&&<Child name="guild" register={guards.guild}/>}
        <Child name="squad" register={guards.squad}/><Child name="world" register={guards.world}/></>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `},bundle:true,write:false,format:'iife',platform:'browser'}).outputFiles[0].text;
  await page.route('**/__chat-leave-guard-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div></body></html>'}));
  await page.goto('/__chat-leave-guard-fixture');await page.addScriptTag({content:script});
  const leave=async(expected:string)=>{await page.getByRole('button',{name:'Leave',exact:true}).click();await expect(page.locator('output')).toHaveText(expected);};
  await leave('allowed');await page.getByRole('button',{name:'Start guild',exact:true}).click();await leave('blocked');
  await page.getByRole('button',{name:'Toggle direct',exact:true}).click();await leave('blocked');
  await page.getByRole('button',{name:'Toggle direct',exact:true}).click();await leave('blocked');
  await page.getByRole('button',{name:'Start world',exact:true}).click();await page.getByRole('button',{name:'Confirm guild',exact:true}).click();await leave('blocked');
  await page.getByRole('button',{name:'Toggle guild',exact:true}).click();await leave('blocked');
  await page.getByRole('button',{name:'Confirm world',exact:true}).click();await leave('allowed');
});
