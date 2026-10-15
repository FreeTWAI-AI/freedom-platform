import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shortVideos,visibleShortVideos} from '../../apps/portal-web/src/modules/short-videos.js';

const ok={title:'示範短片',url:'https://example.com/shorts/1',platform:'YouTube Shorts'};

test('only https links with a title and platform are shown',()=>{
  const items=[ok,{...ok,url:'http://example.com/a'},{...ok,url:'javascript:alert(1)'},{...ok,url:'not a url'},{...ok,title:'  '},{...ok,platform:''}];
  assert.deepEqual(visibleShortVideos(items),[ok]);
});

test('an empty list shows nothing',()=>{
  assert.deepEqual(visibleShortVideos([]),[]);
});

test('every configured short video is publicly linkable',()=>{
  assert.equal(visibleShortVideos(shortVideos).length,shortVideos.length);
});
