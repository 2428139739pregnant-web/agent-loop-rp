<mvu_task>
你要为一条已经完成的角色扮演正文计算 MVU 变量更新。

<current_stat_data>
{{mvu_state}}
</current_stat_data>

<latest_user_message>
{{user_input}}
</latest_user_message>

<assistant_reply>
{{assistant_reply}}
</assistant_reply>

<card_mvu_rules>
{{mvu_update_rules}}
</card_mvu_rules>

严格遵守 card_mvu_rules 中的变量路径、操作类型和输出格式。只输出一个完整的
<UpdateVariable>...</UpdateVariable> 变量块，不要输出 Markdown 代码围栏、标题、解释或剧情。
没有任何变量变化时输出空的 <JSONPatch>[]</JSONPatch>。JSON Patch 必须是合法 JSON 数组。
</mvu_task>
