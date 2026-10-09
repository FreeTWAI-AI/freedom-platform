import {test} from './fixtures.js';
import {sharingCases} from './sharing-authoring-fixture.js';
for (const [name,run] of Object.entries(sharingCases)) test(name,async({page})=>{await run(page);});
