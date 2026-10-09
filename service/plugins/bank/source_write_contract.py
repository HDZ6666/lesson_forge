"""The connection-scoped mutex shared by every source-bank writer.

Keep the existing Publisher lock name: MySQL table swaps implicitly commit,
so a transaction row lock cannot serialize them with incremental batches.
"""

SOURCE_WRITE_LOCK_NAME = 'ruoyi:bank:dataset-publish'
