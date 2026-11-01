import {findPackageRoot,metadata} from '../release/runtime.js'
export const IAM_VERSION = metadata(findPackageRoot(import.meta.url,'@hivemagnus/hive-iam-server')).version
