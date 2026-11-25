import shutil, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from era_memory import MemoryConfig, MemoryEngine


class EngineCase(unittest.TestCase):
    async_mode = False

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="era_mem_test_")
        self.engines = []

    def tearDown(self):
        for e in self.engines:
            e.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def cfg(self, **kw):
        kw.setdefault("async_processing", self.async_mode)
        return MemoryConfig(storage_dir=self.dir, **kw)

    def engine(self, **kw):
        e = MemoryEngine(self.cfg(**kw))
        self.engines.append(e)
        return e
