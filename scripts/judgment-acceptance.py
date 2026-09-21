#!/usr/bin/env python3
"""Owner-bound optional acceptance tool; never mutates canonical business state."""
import json, os, sys
from pathlib import Path
runtime=Path.home()/'.local/share/yeisme-judgment-acceptance'
sys.path.insert(0,str(runtime))
from acceptance_owner import main, case, cli_json, bounded
ROOT=Path(__file__).resolve().parents[3]
OWNER='radar'
STORE=Path.home()/'.local/share'/OWNER/'judgment-acceptance/jev-real-20260921'

def collect():
 rows=cli_json(['radar','market','reading','list','--language','zh-Hans','--json'])['items']
 out=[];gaps=[]
 for row in rows:
  if row.get('origin')!='live':continue
  data={k:row.get(k) for k in ('original_title','display_title','source_locale','status')}
  out.append(case(row['work_ref'],row['display_title'],json.dumps(data,ensure_ascii=False),'原阅读列表条目，缺失翻译回退原文；不代表市场机会已验证。',row['work_revision'],
   'Does the available reading material contain enough evidence to recommend this work as a short-drama market opportunity? Do not infer genre, popularity, audience geography, or plot from its title.',
   {'supported':'Enough explicit evidence for recommendation','needs_verification':'Some relevant evidence but important claims need verification','insufficient':'Only title or catalog metadata; no basis for recommendation'},['当前读取只含目录元数据，没有剧情简介或市场表现；本题验收是否正确拒绝过度推断。']))
 return out,['reading_context_title_only','no_active_personal_profile']

if __name__=="__main__":main(OWNER,STORE,collect)
