# 수식 렌더링 테스트

## 인라인 수식

질량-에너지 등가 원리는 $E = mc^2$ 로 표현됩니다.
피타고라스 정리 $a^2 + b^2 = c^2$ 는 한글 문장 중간에 있어도 깨지지 않아야 합니다.

그리스 문자: $\alpha, \beta, \gamma, \Delta, \pi, \Omega$

## 블록 수식

가우스 적분:

$$
\int_{0}^{\infty} e^{-x^2}\, dx = \frac{\sqrt{\pi}}{2}
$$

이차 방정식의 근의 공식:

$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$

## 행렬

$$
A = \begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix},
\qquad
A^{-1} = \frac{1}{\det A} \begin{pmatrix} 4 & -2 \\ -3 & 1 \end{pmatrix}
$$

## 첨자와 극한

$$
\lim_{n \to \infty} \sum_{k=1}^{n} \frac{1}{k^2} = \frac{\pi^2}{6}
$$

## LaTeX 괄호 표기 (`\(...\)`, `\[...\]`)

직교 조건 \(\int_{0}^{T_s} \phi_1(t) \phi_2(t) dt = 0\) 은 한글 문장 중간에서도 렌더링되어야 합니다.

블록 표기:

\[
\int_{0}^{T_s} \phi_1(t) \phi_2(t)\, dt = 0
\]

## 잘못된 수식 (앱이 죽지 않아야 함)

인라인 오류: $\frac{1}{$ 이렇게 잘못된 수식이 있어도 나머지 문서는 정상 렌더링되어야 합니다.

$$
\invalidcommand{x}
$$

## 수식이 포함된 표

| 이름 | 공식 |
|---|---|
| 오일러 항등식 | $e^{i\pi} + 1 = 0$ |
| 표준편차 | $\sigma = \sqrt{\frac{1}{N}\sum_{i=1}^{N}(x_i-\mu)^2}$ |
