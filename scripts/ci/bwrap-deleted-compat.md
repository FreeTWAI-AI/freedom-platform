This is an uninstalled compatibility candidate, pending actual Ubuntu kernel
exec-denial evidence. The prerequisite loader does not invoke this renderer.

`render-bwrap-deleted-compat.py` accepts only the exact reviewed Noble stock
profile (SHA256 `11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9`).
It adds `mediate_deleted` to the two existing profile declarations. The output
SHA256 is `a964037f6cf0df1099f14226b037eaedde6237c86e715188e93eb460b30be859`.
Every other byte, including capability denial, px/pix transitions, local
includes, ABI4 and userns permissions, remains unchanged. The renderer neither
loads policy nor modifies the installed source.

The two flags match [upstream AppArmor5.0.2 lines15 and59](https://gitlab.com/apparmor/apparmor/-/blob/v5.0.2/profiles/apparmor/profiles/extras/bwrap-userns-restrict#L15).
That entire newer profile is unsuitable as a minimal replacement: it also
changes ABI and other rules. This candidate copies only the two flag additions.

[Linux6.8 path.c lines149–152](https://github.com/torvalds/linux/blob/v6.8/security/apparmor/path.c#L149)
returns ENOENT for a deleted positive dentry without deleted mediation;
[domain.c profile_transition](https://github.com/torvalds/linux/blob/v6.8/security/apparmor/domain.c#L631)
uses profile path flags before exec-transition lookup.
[AppArmor4.0.1 compiler lines435–447](https://gitlab.com/apparmor/apparmor/-/blob/v4.0.1/parser/parser_interface.c#L435)
serializes explicit attachment flags without implicitly adding deleted mediation.
These explain a possible failure; they do not prove the remote failure cause.

The extracted official Noble AppArmor4.0.1 parser successfully compiled the
candidate using `--skip-kernel-load --skip-cache` and its extracted policy include
base. `--names` returned exactly `bwrap` and `unpriv_bwrap`. Three altered-input
counterexamples (extra byte, changed capability denial, changed px transition)
were rejected. No kernel policy was loaded, package upgraded, permission changed,
or sandbox isolation reduced. Actual candidate-policy exec remains not_run.
