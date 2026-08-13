# 종합 테스트 문서

한글 본문, **수식**, `코드`, 표, 이미지가 모두 포함된 종합 테스트입니다.

## 1. 물리 공식 정리

운동 에너지는 $E_k = \frac{1}{2}mv^2$ 이고, 위치 에너지는 $E_p = mgh$ 입니다.

전체 역학적 에너지 보존:

$$
E = E_k + E_p = \frac{1}{2}mv^2 + mgh = \text{const}
$$

## 2. 계산 코드

```python
def kinetic_energy(m: float, v: float) -> float:
    """운동 에너지 계산 (J)"""
    return 0.5 * m * v ** 2

print(kinetic_energy(70, 10))  # 3500.0
```

## 3. 실험 결과 표

| 실험 | 질량 (kg) | 속도 (m/s) | 에너지 (J) | 판정 |
|---|---:|---:|---:|:---:|
| A | 70 | 10 | $3.5 \times 10^3$ | ✅ |
| B | 55 | 12 | $3.96 \times 10^3$ | ✅ |
| C | 80 | 8 | $2.56 \times 10^3$ | ⚠️ |

## 4. 이미지

![샘플 이미지](images/sample.png)

## 5. 체크리스트

- [x] 수식 확인
- [x] 코드 확인
- [ ] 다크 모드에서 재확인

> 참고: 이 문서는 라이트/다크 모드 모두에서 가독성이 좋아야 합니다.

외부 링크: [Electron 공식 문서](https://www.electronjs.org/docs/latest/)
