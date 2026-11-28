# Ownership & License

Copyright © 2026 AnnaSoft Inc. (Republic of Korea)

## The code
The code in this repository (the library, adopt-example and tests) is licensed under the
[Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0).

## The specification
The specification (spec.ko.md, spec.en.md) may be copied and shared unchanged, with credit. Changed
versions may not be shared. Only AnnaSoft publishes new versions.

## Following the specification
A product or service follows this specification when it does all of these:
1. Every value in a call has a source, recorded with it.
2. A value not yet confirmed is UNKNOWN, and is not filled by the model.
3. Each condition is declared by the party that holds it: the tool's provider, the user, or the adopting system.
4. Code, not the model, decides whether each condition holds, from the sources declared for it. The call's
   arguments and what the model says are not among them.
5. Every call to a tool goes through the gate, and whether it runs follows the decision record, which is kept.
6. What cannot be confirmed is recorded as not confirmed, with the party that can settle it: the user, the
   system, or the party that declared it.

Organizations with annual revenue of USD 100 million or more need a commercial license to state that a
product or service follows this specification, or to use its name for it.

## Warranty
The specification is provided as is, without warranty of any kind. The copyright holder is not liable for
any damages arising from its use. For the code, see the Apache License.

Contact: [hello@anna.software](mailto:hello@anna.software)
