import unittest
from types import SimpleNamespace
import numpy as np
from main import map_nd2_channels


def metadata(colors):
    return SimpleNamespace(channels=[SimpleNamespace(channel=SimpleNamespace(name=name, color=SimpleNamespace(r=r,g=g,b=b))) for name,r,g,b in colors])


class ChannelMappingTests(unittest.TestCase):
    def test_nd2_bgr_is_permuted_without_rescaling(self):
        source=np.array([[[1005,434,399],[2958,2465,2396]]],dtype=np.uint16)
        original=source.copy()
        mapped,info=map_nd2_channels(source,metadata([('dapi',0,102,255),('GFP',54,255,0),('TxRed',255,21,0)]))
        np.testing.assert_array_equal(mapped,source[:,:,[2,1,0]])
        np.testing.assert_array_equal(source,original)
        self.assertEqual(info,{'method':'nd2-color-metadata','sourceIndices':[2,1,0],'sourceNames':['TxRed','GFP','dapi']})

    def test_ambiguous_missing_and_two_channel_colors_remain_explicit_source_order(self):
        source=np.array([[[1,2,3]]],dtype=np.uint16)
        for meta in [None,metadata([('a',255,255,255),('b',0,255,0),('c',255,0,0)]),metadata([('a',255,0,0),('b',255,0,0),('c',0,0,255)])]:
            mapped,info=map_nd2_channels(source,meta)
            np.testing.assert_array_equal(mapped,source)
            self.assertEqual(info['method'],'source-order')
            self.assertEqual(info['sourceIndices'],[0,1,2])
        mapped,info=map_nd2_channels(source[:,:,:2],metadata([('dapi',0,0,255),('GFP',0,255,0)]))
        self.assertEqual(info['sourceIndices'],[0,1])
        np.testing.assert_array_equal(mapped,source[:,:,:2])
