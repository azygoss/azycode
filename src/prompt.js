import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function ask(question, fallback = "") {
  const rl = readline.createInterface({ input, output });
  try {
    const suffix = fallback ? ` (${fallback})` : "";
    const answer = await rl.question(`${question}${suffix}: `);
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

export async function askSecret(question) {
  if (!process.stdin.isTTY) return ask(question);
  const mutableStdout = new Proxy(output, {
    get(target, prop) {
      if (prop === "write") {
        return (chunk, encoding, cb) => {
          if (String(chunk).includes(question)) return target.write(chunk, encoding, cb);
          return target.write("*".repeat(String(chunk).length), encoding, cb);
        };
      }
      return target[prop];
    }
  });
  const rl = readline.createInterface({ input, output: mutableStdout, terminal: true });
  try {
    const answer = await rl.question(`${question}: `);
    output.write("\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question, defaultYes = false) {
  const fallback = defaultYes ? "y" : "n";
  const answer = (await ask(`${question} [y/n]`, fallback)).toLowerCase();
  return answer === "y" || answer === "yes" || answer === "evet" || answer === "e";
}
