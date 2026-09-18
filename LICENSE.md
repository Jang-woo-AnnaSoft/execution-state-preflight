# Ownership & License

Copyright © 2026 AnnaSoft Inc. (Republic of Korea)

## 1. Agent-side implementation — free

Implementing this framework, source code, and specification in a layer outside the model is free for every organization. That includes shipping it inside a product or service you sell commercially, and it places no restriction on modification or redistribution.

An implementation where deterministic code outside the model does the looking up, the counting, and the recording falls under this section even when it runs inside model serving infrastructure.

## 2. Model-internal application — paid

A separate commercial license is required to make the structure described in this work part of the model's own behavior and ship that in a product or service you sell commercially. This covers putting it into weights, into network layers, or into a training objective, and it covers having the model's own generation perform the slot verdict.

The structure means the following. Keeping declaration, verdict, record, and execution outside the model; settling a value by provenance lookup rather than by generation; and a deterministic gate that counts unresolved slots before execution.

This section applies only to organizations whose total revenue in the prior fiscal year was USD 1 billion or more. Both the revenue and the amount are measured on that prior fiscal year. Revenue is counted across the entity that ships the product or service, the companies consolidated into that entity's financial statements, and any company that consolidates that entity.

Internal research that is not shipped does not fall under this section.

## 3. Warranty

This work is provided as is, without warranty of any kind. The copyright holder is not liable for any damages arising from its use.

Contact: [hello@anna.software](mailto:hello@anna.software)
