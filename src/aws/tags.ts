/** What AWS takes as a tag's key. */
export const TAG_KEY_REGEX = /^(?!aws:)[A-Za-z0-9 _.:\-=+@]{1,128}$/;
/** What AWS takes as a tag's value. */
export const TAG_VALUE_REGEX = /^[\p{L}\p{Z}\p{N}_.:/=+\-@]{0,256}$/u;

/** Where a sandbox's meta goes in its tags. */
export const META_TAG = 'run.rowdy.meta.';
