// Clone-owned (v1.6.0), like org-hooks.ts: the optional modules that plug into core. Imported for its side effect by
// the routes that sign people in (/login/request, /login/redeem). Removing a module deletes its
// marked lines (foundation:check-modules).
import { registerSsoHooks } from '@/core/auth/sso-hook'; // sso
import { ssoHooks } from '@/modules/sso/hooks'; // sso

registerSsoHooks(ssoHooks); // sso
