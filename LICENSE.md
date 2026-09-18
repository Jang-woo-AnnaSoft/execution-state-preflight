# Ownership & License

Copyright © 2026 AnnaSoft Inc. (Republic of Korea)

## 1. Agent-side implementation — free

Implementing this framework, source code, and specification in a layer outside the model is free for every organization. That includes shipping it inside a product or service you sell commercially, and it places no restriction on modification or redistribution.

An implementation where deterministic code outside the model does the looking up, the counting, and the recording falls under this section even when it runs inside model serving infrastructure.

## 2. Model-internal application — paid

A separate commercial license is required to make the structure described in this work part of the model's own behavior and ship that in a product or service you sell commercially. This covers putting it into weights, into network layers, or into a training objective, and it covers having the model's own generation perform the slot verdict.

The structure means the following. Keeping declaration, verdict, record, and execution outside the model; settling a value by provenance lookup rather than by generation; and a deterministic gate that counts unresolved slots before execution.

This section applies only to organizations whose total revenue in the prior fiscal year was USD 1 billion or more (2026 dollars). Revenue is counted across the entity that ships the product or service, the companies consolidated into that entity's financial statements, and any company that consolidates that entity.

Internal research that is not shipped does not fall under this section.

## 3. Warranty

This work is provided as is, without warranty of any kind. The copyright holder is not liable for any damages arising from its use.

Contact: [hello@anna.software](mailto:hello@anna.software)

---

# 소유권 및 라이선스

Copyright © 2026 AnnaSoft Inc. (대한민국)

English: [LICENSE.md](./LICENSE.md)

## 1. 에이전트 구현 (무상)

이 프레임워크와 소스 코드, 명세를 모델 바깥의 계층에 구현하는 것은 모든 조직에 무상으로 허용된다. 상업적으로 배포하는 제품이나 서비스에 포함하는 경우를 포함하며, 수정과 재배포에도 제한을 두지 않는다.

모델 바깥의 결정론적 코드가 조회하고 세고 기록하는 구현은, 그것이 모델 서빙 인프라 안에 배치되더라도 이 항에 해당한다.

## 2. 모델 내부 적용 (유상)

이 저작물에 기술된 구조를 모델 자신의 동작으로 만들고, 이를 상업적으로 배포하는 제품이나 서비스에 사용하려면 별도의 상업 라이선스가 필요하다. 가중치나 신경망 계층, 학습 목표에 넣는 경우, 또는 슬롯 판정 자체를 모델의 생성으로 수행하도록 만드는 경우가 여기에 해당한다.

여기서 말하는 구조는 다음을 가리킨다. 선언과 판정과 기록과 실행을 모델 밖에 두는 것, 값을 생성이 아니라 출처 조회로 확정하는 것, 실행 전에 미확인 슬롯을 세는 결정론적 게이트.

이 항은 직전 회계연도 총매출이 10억 달러(2026년 기준) 이상인 조직에만 적용된다. 매출은 해당 제품이나 서비스를 배포하는 법인과, 그 법인의 연결재무제표에 포함되는 회사 및 그 법인을 연결재무제표에 포함하는 회사를 합산해 산정한다.

배포하지 않는 내부 연구는 이 항에 해당하지 않는다.

## 3. 보증

이 저작물은 어떠한 보증도 없이 있는 그대로 제공된다. 저작권자는 이 저작물의 사용으로 발생한 어떠한 손해에 대해서도 책임지지 않는다.

연락처: [hello@anna.software](mailto:hello@anna.software)
