#!/bin/bash
# RAG 服务冒烟测试：embed -> add -> search(含rerank) 全链路
set -e
sleep 12
echo "=== health ==="
curl -s -m 10 http://127.0.0.1:8091/health
echo; echo "=== embed 推理测试（首次会触发模型加载）==="
curl -s -m 120 -X POST http://127.0.0.1:8091/embed -H 'Content-Type: application/json' \
  -d '{"texts":["蒲公英煮鸡蛋可以消肿散结","金刚绕掌每天五十下提升免疫力"],"is_query":false}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); import numpy as np; v=np.array(d['vectors']); print('向量shape:',v.shape,'模长:',np.linalg.norm(v,axis=1))"
echo "=== add 写入4条 ==="
curl -s -m 120 -X POST http://127.0.0.1:8091/add -H 'Content-Type: application/json' -d '{
 "items":[
  {"text":"蒲公英煮鸡蛋能消肿散结，适合气滞血瘀导致的肺结节、乳腺结节的人食用。","meta":{"category":"健康养生","doc_id":"t1","chunk":0}},
  {"text":"山楂搭配丹参、陈皮煮鸡蛋，活血化瘀，适合心脑血管堵塞人群。","meta":{"category":"健康养生","doc_id":"t1","chunk":1}},
  {"text":"跳槽是薪资翻倍最好的方法，中年危机的本质是你一直在重复做事没有成长。","meta":{"category":"职场成长","doc_id":"t2","chunk":0}},
  {"text":"金刚绕掌每天五十下，大拇指抵住无名指转动，提升体质增强免疫力。","meta":{"category":"健康养生","doc_id":"t3","chunk":0}}
 ]}'
echo; echo "=== search 测试（query=肺结节吃什么，期望健康类食疗排前）==="
curl -s -m 180 -X POST http://127.0.0.1:8091/search -H 'Content-Type: application/json' \
  -d '{"query":"肺结节可以吃什么调理","top_k":3,"rerank":true}' | python3 -m json.tool --no-ensure-ascii 2>/dev/null | head -40
