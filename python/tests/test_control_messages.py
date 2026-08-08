import unittest

from google.protobuf import descriptor_pool

from rpcstream import rpcstream_pb2
from srpc import rpcproto_pb2


class ControlMessagesTest(unittest.TestCase):
    def test_imports_descriptors_oneof_and_empty_presence_flag(self) -> None:
        packet = rpcproto_pb2.Packet(
            call_start=rpcproto_pb2.CallStart(
                rpc_service="svc", rpc_method="method", data_is_zero=True
            )
        )
        self.assertEqual(packet.WhichOneof("body"), "call_start")
        self.assertTrue(packet.call_start.data_is_zero)
        self.assertIsNotNone(
            descriptor_pool.Default().FindMessageTypeByName("srpc.Packet")
        )
        self.assertIsNotNone(
            descriptor_pool.Default().FindMessageTypeByName("rpcstream.RpcStreamPacket")
        )
        self.assertEqual(
            rpcstream_pb2.RpcStreamPacket(
                init=rpcstream_pb2.RpcStreamInit(component_id="3")
            ).WhichOneof("body"),
            "init",
        )

    def test_runtime_pin(self) -> None:
        import google.protobuf

        self.assertEqual(google.protobuf.__version__, "6.33.5")


if __name__ == "__main__":
    unittest.main()
