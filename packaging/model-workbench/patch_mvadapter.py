"""Apply the minimal Accelerate reference-cache fix to both SD variants.

Upstream revision: 4277e0018232bac82bb2c103caf0893cedb711be.
The original research patch only covered SDXL; both pipelines need it when
Accelerate recursively copies cross_attention_kwargs during CPU offload.
"""
from pathlib import Path
import sys


def patch(root):
    processor = root/'mvadapter/models/attention_processor.py'
    text = processor.read_text()
    if '_levelup_reference_cache' not in text:
        needle = '            cache_hidden_states[self.name] = hidden_states.clone()'
        if text.count(needle) != 2:
            raise ValueError('Unexpected MV-Adapter attention source revision')
        text = text.replace(needle,needle+'\n            self._levelup_reference_cache = cache_hidden_states[self.name]')
        processor.write_text(text)
    for name in ('sd','sdxl'):
        pipeline = root/f'mvadapter/pipelines/pipeline_mvadapter_i2mv_{name}.py'
        text = pipeline.read_text()
        if '_levelup_reference_cache' in text:
            continue
        needle = '            ref_hidden_states = {\n                k: v.repeat_interleave(num_images_per_prompt, dim=0)'
        if text.count(needle) != 1:
            raise ValueError('Unexpected MV-Adapter pipeline revision')
        recovery = '''            for name, processor in self.unet.attn_processors.items():
                if hasattr(processor, "_levelup_reference_cache"):
                    ref_hidden_states[name] = processor._levelup_reference_cache
                    del processor._levelup_reference_cache
            if not ref_hidden_states:
                raise RuntimeError("Reference attention cache was not populated")
'''
        pipeline.write_text(text.replace(needle,recovery+needle))


if __name__ == '__main__':
    patch(Path(sys.argv[1]))
