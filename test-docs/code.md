# 코드 하이라이팅 테스트

## Python

```python
def greet(name: str) -> str:
    """한글 주석: 인사말을 만든다."""
    message = f"안녕하세요, {name}님!"
    return message

if __name__ == "__main__":
    print(greet("세계"))
```

## JavaScript

```javascript
// 한글 주석: 피보나치
const fib = (n) => (n <= 1 ? n : fib(n - 1) + fib(n - 2));
console.log([...Array(10).keys()].map(fib)); // [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
```

## TypeScript

```typescript
interface User {
  name: string;
  age: number;
}

const user: User = { name: "홍길동", age: 30 };
```

## Bash

```bash
#!/usr/bin/env bash
# 한글 주석: md 파일 개수 세기
find . -name "*.md" | wc -l
```

## C++

```cpp
#include <iostream>

int main() {
    std::cout << "안녕하세요" << std::endl; // 한글 출력
    return 0;
}
```

## JSON

```json
{
  "이름": "Markdown Viewer",
  "버전": "0.1.0",
  "지원": ["md", "markdown", "txt"]
}
```

## 언어 미지정

```
플레인 텍스트 블록입니다.
   들여쓰기와  공백이   그대로 유지되어야 합니다.
```

## 긴 한 줄 (가로 스크롤 확인)

```python
result = some_function_with_a_very_long_name(argument_one=1, argument_two=2, argument_three=3, argument_four=4, argument_five=5, argument_six=6, argument_seven=7)
```
