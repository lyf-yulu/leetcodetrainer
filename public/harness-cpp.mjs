/**
 * C++ judge driver generation.
 *
 * Ships a compact JSON value type plus overload-resolved `from()`/`to()` converters,
 * so nested types (vector<vector<int>>, ListNode*, TreeNode*) fall out of overload
 * resolution instead of needing per-type codegen. Only the argument declarations and
 * the call itself are generated from metaData.
 *
 * Note: no <bits/stdc++.h> — that is a libstdc++ extension and Apple clang lacks it.
 */

import { SENTINEL, isSystemDesign } from './harness.mjs';

const PRELUDE = `#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include <unordered_map>
#include <unordered_set>
#include <map>
#include <set>
#include <queue>
#include <stack>
#include <deque>
#include <algorithm>
#include <numeric>
#include <climits>
#include <cmath>
#include <cstring>
#include <functional>
#include <chrono>
#include <iomanip>
#include <memory>
#include <utility>
#include <list>
#include <bitset>
#include <array>
#include <tuple>
#include <stdexcept>
using namespace std;

struct ListNode {
  int val; ListNode *next;
  ListNode() : val(0), next(nullptr) {}
  ListNode(int x) : val(x), next(nullptr) {}
  ListNode(int x, ListNode *n) : val(x), next(n) {}
};

struct TreeNode {
  int val; TreeNode *left; TreeNode *right;
  TreeNode() : val(0), left(nullptr), right(nullptr) {}
  TreeNode(int x) : val(x), left(nullptr), right(nullptr) {}
  TreeNode(int x, TreeNode *l, TreeNode *r) : val(x), left(l), right(r) {}
};

namespace lct {

struct Json {
  enum Type { NUL, BOOL, NUM, STR, ARR } t = NUL;
  bool b = false;
  double n = 0;
  std::string s;
  std::vector<Json> a;
  std::vector<std::pair<std::string, Json>> o;

  const Json& at(size_t i) const {
    static Json nil;
    return i < a.size() ? a[i] : nil;
  }
  const Json& key(const std::string& k) const {
    static Json nil;
    for (const auto& kv : o) if (kv.first == k) return kv.second;
    return nil;
  }
  bool isNull() const { return t == NUL; }
};

struct Parser {
  const std::string& src; size_t i = 0;
  explicit Parser(const std::string& s) : src(s) {}
  void ws() { while (i < src.size() && (src[i]==' '||src[i]=='\\n'||src[i]=='\\t'||src[i]=='\\r')) i++; }

  Json parse() { ws(); return value(); }

  Json value() {
    ws();
    if (i >= src.size()) return Json();
    char c = src[i];
    if (c == '{') return object();
    if (c == '[') return array();
    if (c == '"') { Json j; j.t = Json::STR; j.s = str(); return j; }
    if (c == 't') { i += 4; Json j; j.t = Json::BOOL; j.b = true; return j; }
    if (c == 'f') { i += 5; Json j; j.t = Json::BOOL; j.b = false; return j; }
    if (c == 'n') { i += 4; return Json(); }
    return number();
  }

  Json object() {
    Json j; j.t = Json::ARR; i++; ws();
    if (i < src.size() && src[i] == '}') { i++; return j; }
    while (i < src.size()) {
      ws(); std::string k = str(); ws();
      if (i < src.size() && src[i] == ':') i++;
      j.o.emplace_back(k, value()); ws();
      if (i < src.size() && src[i] == ',') { i++; continue; }
      if (i < src.size() && src[i] == '}') { i++; break; }
      break;
    }
    return j;
  }

  Json array() {
    Json j; j.t = Json::ARR; i++; ws();
    if (i < src.size() && src[i] == ']') { i++; return j; }
    while (i < src.size()) {
      j.a.push_back(value()); ws();
      if (i < src.size() && src[i] == ',') { i++; continue; }
      if (i < src.size() && src[i] == ']') { i++; break; }
      break;
    }
    return j;
  }

  std::string str() {
    std::string out;
    if (i < src.size() && src[i] == '"') i++;
    while (i < src.size() && src[i] != '"') {
      if (src[i] == '\\\\' && i + 1 < src.size()) {
        i++;
        char e = src[i++];
        switch (e) {
          case 'n': out += '\\n'; break;
          case 't': out += '\\t'; break;
          case 'r': out += '\\r'; break;
          case 'b': out += '\\b'; break;
          case 'f': out += '\\f'; break;
          case 'u': {
            int cp = std::stoi(src.substr(i, 4), nullptr, 16); i += 4;
            if (cp < 0x80) out += char(cp);
            else if (cp < 0x800) { out += char(0xC0 | (cp >> 6)); out += char(0x80 | (cp & 0x3F)); }
            else { out += char(0xE0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
            break;
          }
          default: out += e;
        }
      } else out += src[i++];
    }
    if (i < src.size() && src[i] == '"') i++;
    return out;
  }

  Json number() {
    size_t start = i;
    while (i < src.size() && (isdigit((unsigned char)src[i]) || src[i]=='-' || src[i]=='+' || src[i]=='.' || src[i]=='e' || src[i]=='E')) i++;
    Json j; j.t = Json::NUM;
    j.n = src.compare(start, i - start, "") == 0 ? 0 : std::stod(src.substr(start, i - start));
    return j;
  }
};

inline std::string esc(const std::string& s) {
  std::string o = "\\"";
  for (unsigned char c : s) {
    if (c == '"') o += "\\\\\\"";
    else if (c == '\\\\') o += "\\\\\\\\";
    else if (c == '\\n') o += "\\\\n";
    else if (c == '\\t') o += "\\\\t";
    else if (c == '\\r') o += "\\\\r";
    else if (c < 0x20) { char buf[8]; snprintf(buf, sizeof buf, "\\\\u%04x", c); o += buf; }
    else o += char(c);
  }
  return o + "\\"";
}

inline std::string num(double d) {
  if (d == (long long)d && std::fabs(d) < 9e15) return std::to_string((long long)d);
  std::ostringstream ss; ss << std::setprecision(10) << d; return ss.str();
}

// ---- deserialize: Json -> C++ value
inline void from(const Json& j, int& v)         { v = (int)j.n; }
inline void from(const Json& j, long long& v)   { v = (long long)j.n; }
inline void from(const Json& j, double& v)      { v = j.n; }
inline void from(const Json& j, bool& v)        { v = j.t == Json::BOOL ? j.b : j.n != 0; }
inline void from(const Json& j, std::string& v) { v = j.s; }
inline void from(const Json& j, char& v)        { v = j.s.empty() ? '\\0' : j.s[0]; }

template <class T> void from(const Json& j, std::vector<T>& v) {
  v.clear(); v.reserve(j.a.size());
  for (const auto& e : j.a) { T t{}; from(e, t); v.push_back(t); }
}

inline void from(const Json& j, ListNode*& head) {
  head = nullptr; ListNode* tail = nullptr;
  for (const auto& e : j.a) {
    ListNode* node = new ListNode((int)e.n);
    if (!head) head = tail = node; else { tail->next = node; tail = node; }
  }
}

inline void from(const Json& j, TreeNode*& root) {
  root = nullptr;
  if (j.a.empty() || j.a[0].isNull()) return;
  root = new TreeNode((int)j.a[0].n);
  std::queue<TreeNode*> q; q.push(root);
  size_t i = 1;
  while (!q.empty() && i < j.a.size()) {
    TreeNode* cur = q.front(); q.pop();
    if (i < j.a.size()) { const Json& L = j.a[i++]; if (!L.isNull()) { cur->left  = new TreeNode((int)L.n); q.push(cur->left); } }
    if (i < j.a.size()) { const Json& R = j.a[i++]; if (!R.isNull()) { cur->right = new TreeNode((int)R.n); q.push(cur->right); } }
  }
}

// ---- serialize: C++ value -> JSON text
inline std::string to(int v)                { return std::to_string(v); }
inline std::string to(long long v)          { return std::to_string(v); }
inline std::string to(double v)             { return num(v); }
inline std::string to(bool v)               { return v ? "true" : "false"; }
inline std::string to(char v)               { return esc(std::string(1, v)); }
inline std::string to(const std::string& v) { return esc(v); }

template <class T> std::string to(const std::vector<T>& v) {
  std::string o = "[";
  for (size_t i = 0; i < v.size(); i++) { if (i) o += ","; o += to(v[i]); }
  return o + "]";
}

inline std::string to(ListNode* n) {
  std::string o = "["; int guard = 0; bool first = true;
  while (n && guard++ < 100000) { if (!first) o += ","; o += std::to_string(n->val); first = false; n = n->next; }
  return o + "]";
}

inline std::string to(TreeNode* root) {
  std::vector<std::string> out;
  if (root) {
    std::queue<TreeNode*> q; q.push(root);
    while (!q.empty()) {
      TreeNode* c = q.front(); q.pop();
      if (!c) { out.push_back("null"); continue; }
      out.push_back(std::to_string(c->val)); q.push(c->left); q.push(c->right);
    }
    while (!out.empty() && out.back() == "null") out.pop_back();
  }
  std::string o = "[";
  for (size_t i = 0; i < out.size(); i++) { if (i) o += ","; o += out[i]; }
  return o + "]";
}

inline void emit(size_t idx, bool ok, const std::string& outJson, double ms, const std::string& err, const std::string& log) {
  std::cout << "${SENTINEL}{\\"i\\":" << idx
            << ",\\"ok\\":" << (ok ? "true" : "false")
            << ",\\"out\\":" << (outJson.empty() ? "null" : outJson)
            << ",\\"ms\\":" << num(ms)
            << ",\\"err\\":" << esc(err)
            << ",\\"log\\":" << esc(log)
            << "}\\n" << std::flush;
}

struct Capture {
  std::ostringstream buf; std::streambuf* old;
  Capture() { old = std::cout.rdbuf(buf.rdbuf()); }
  ~Capture() { std::cout.rdbuf(old); }
  std::string str() { return buf.str(); }
};

} // namespace lct
`;

const TYPE_MAP = {
  integer: 'int',
  int: 'int',
  long: 'long long',
  double: 'double',
  float: 'double',
  boolean: 'bool',
  string: 'string',
  String: 'string',
  character: 'char',
  char: 'char',
  void: 'void',
  ListNode: 'ListNode*',
  TreeNode: 'TreeNode*',
};

/** Maps a LeetCode metaData type string to a C++ type. */
export function cppType(raw) {
  if (!raw) return 'void';
  let t = String(raw).trim();

  const list = t.match(/^list<(.+)>$/i);
  if (list) return `vector<${cppType(list[1])}>`;

  if (t.endsWith('[]')) return `vector<${cppType(t.slice(0, -2))}>`;

  return TYPE_MAP[t] || TYPE_MAP[t.toLowerCase()] || 'int';
}

function buildFunction(meta) {
  const params = meta.params || [];
  const decls = params.map((p, i) => {
    const type = cppType(p.type);
    return `      ${type} a${i}{}; lct::from(in.at(${i}), a${i});`;
  }).join('\n');

  const args = params.map((_, i) => `a${i}`).join(', ');
  const retType = cppType(meta.return?.type);
  const isVoid = retType === 'void';

  // Void-returning problems mutate their first argument in place; report that instead.
  const callAndSerialize = isVoid
    ? `      sol.${meta.name}(${args});
      outJson = lct::to(a0);`
    : `      auto res = sol.${meta.name}(${args});
      outJson = lct::to(res);`;

  return `
int main() {
  std::string src((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
  lct::Parser parser(src);
  lct::Json tests = parser.parse();

  for (size_t ti = 0; ti < tests.a.size(); ti++) {
    const lct::Json& in = tests.a[ti].key("input");
    std::string outJson, err, log;
    bool ok = true;
    double ms = 0;
${decls}
    {
      lct::Capture cap;
      auto t0 = std::chrono::steady_clock::now();
      try {
        Solution sol;
${callAndSerialize}
      } catch (const std::exception& e) {
        ok = false; err = std::string("exception: ") + e.what();
      } catch (...) {
        ok = false; err = "unknown exception";
      }
      ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
      log = cap.str();
    }
    lct::emit(ti, ok, outJson, ms, err, log);
  }
  return 0;
}
`;
}

function buildDesign(meta) {
  const ctorParams = meta.constructor?.params || [];
  const ctorDecls = ctorParams.map((p, i) => {
    const type = cppType(p.type);
    return `          ${type} c${i}{}; lct::from(args.at(${i}), c${i});`;
  }).join('\n');
  const ctorArgs = ctorParams.map((_, i) => `c${i}`).join(', ');

  const branches = (meta.methods || []).map((m) => {
    const ps = m.params || [];
    const decls = ps.map((p, i) => {
      const type = cppType(p.type);
      return `            ${type} m${i}{}; lct::from(args.at(${i}), m${i});`;
    }).join('\n');
    const args = ps.map((_, i) => `m${i}`).join(', ');
    const isVoid = cppType(m.return?.type) === 'void';
    const body = isVoid
      ? `            obj->${m.name}(${args}); results.push_back("null");`
      : `            results.push_back(lct::to(obj->${m.name}(${args})));`;
    return `          if (op == "${m.name}") {
${decls}
${body}
            continue;
          }`;
  }).join('\n');

  return `
int main() {
  std::string src((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
  lct::Parser parser(src);
  lct::Json tests = parser.parse();

  for (size_t ti = 0; ti < tests.a.size(); ti++) {
    const lct::Json& in = tests.a[ti].key("input");
    const lct::Json& ops = in.at(0);
    const lct::Json& argList = in.at(1);

    std::vector<std::string> results;
    std::string err, log;
    bool ok = true;
    double ms = 0;
    ${meta.classname}* obj = nullptr;

    {
      lct::Capture cap;
      auto t0 = std::chrono::steady_clock::now();
      try {
        for (size_t k = 0; k < ops.a.size(); k++) {
          std::string op = ops.a[k].s;
          const lct::Json& args = argList.at(k);
          if (k == 0) {
${ctorDecls}
            obj = new ${meta.classname}(${ctorArgs});
            results.push_back("null");
            continue;
          }
${branches}
          results.push_back("null");
        }
      } catch (const std::exception& e) {
        ok = false; err = std::string("exception: ") + e.what();
      } catch (...) {
        ok = false; err = "unknown exception";
      }
      ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
      log = cap.str();
    }

    std::string outJson = "[";
    for (size_t i = 0; i < results.size(); i++) { if (i) outJson += ","; outJson += results[i]; }
    outJson += "]";
    lct::emit(ti, ok, outJson, ms, err, log);
  }
  return 0;
}
`;
}

const USER_BANNER = '// ---------------- user solution ----------------';

export function buildCpp(meta, userCode) {
  const driver = isSystemDesign(meta) ? buildDesign(meta) : buildFunction(meta);
  return [
    PRELUDE,
    USER_BANNER,
    userCode,
    '// ---------------- judge driver ----------------',
    driver,
  ].join('\n');
}

/** 1-based line in the generated main.cpp where the user's code starts. */
export function cppUserOffset() {
  return [PRELUDE, USER_BANNER].join('\n').split('\n').length + 1;
}
