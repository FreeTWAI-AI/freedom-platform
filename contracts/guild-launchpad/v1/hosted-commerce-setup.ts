import {z} from 'zod';
import {OpaqueId,Version} from './primitives.js';
export const CommerceSetupEmptyInputSchema=z.object({}).strict();
const release=z.object({module_release_ref:z.string().min(1).max(200),application_release_ref:z.string().min(1).max(200)}).strict();
export const StoreReleaseSchema=release.extend({version:Version,capabilities:z.array(z.string()).max(100),upgrade:release.nullable(),can_upgrade:z.boolean()}).strict();
