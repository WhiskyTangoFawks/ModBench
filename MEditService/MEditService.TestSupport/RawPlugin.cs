using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using MEditService.Codec.Schema;

namespace MEditService.TestSupport;

/// <summary>Plugin bytes laid out by hand, so a fixture can carry a shape Mutagen would never write.</summary>
public static class RawPlugin
{
    private const uint LightFlag = 0x200;
    private const ushort Fallout4FormVersion = 131;
    private const int HeaderLength = 24;

    public static byte[] Subrecord(string signature, byte[] payload)
    {
        var bytes = new byte[6 + payload.Length];
        Encoding.ASCII.GetBytes(signature).CopyTo(bytes, 0);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(4), (ushort)payload.Length);
        payload.CopyTo(bytes, 6);
        return bytes;
    }

    public static byte[] Record(string type, uint formId, params byte[][] subrecords) =>
        Record(type, formId, 0, Fallout4FormVersion, subrecords);

    public static byte[] Record(string type, uint formId, uint flags, ushort formVersion, params byte[][] subrecords) =>
        RecordAroundPayload(type, formId, flags, formVersion, Concat(subrecords));

    public static byte[] DeflatedRecord(
        string type, uint formId, CompressionLevel level, params byte[][] subrecords)
    {
        var subrecordBytes = Concat(subrecords);
        var inflatedLength = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(inflatedLength, (uint)subrecordBytes.Length);
        using var payload = new MemoryStream();
        payload.Write(inflatedLength);
        using (var zlib = new ZLibStream(payload, level, leaveOpen: true))
            zlib.Write(subrecordBytes);
        return RecordAroundPayload(type, formId, (uint)CompressedFlag.Bit, Fallout4FormVersion, payload.ToArray());
    }

    public static byte[] Group(string recordType, params byte[][] contents) =>
        Group(Encoding.ASCII.GetBytes(recordType), 0, contents);

    public static byte[] Group(byte[] label, int groupType, params byte[][] contents)
    {
        var data = Concat(contents);
        var bytes = new byte[HeaderLength + data.Length];
        Encoding.ASCII.GetBytes("GRUP").CopyTo(bytes, 0);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), (uint)bytes.Length);
        label.CopyTo(bytes, 8);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(12), groupType);
        data.CopyTo(bytes, HeaderLength);
        return bytes;
    }

    public static byte[] Tes4(
        uint nextObjectId = 0x800, uint numRecords = 0, bool light = false, params string[] masters)
    {
        var hedr = new byte[12];
        BinaryPrimitives.WriteSingleLittleEndian(hedr, 1.0f);
        BinaryPrimitives.WriteUInt32LittleEndian(hedr.AsSpan(4), numRecords);
        BinaryPrimitives.WriteUInt32LittleEndian(hedr.AsSpan(8), nextObjectId);
        var subrecords = new List<byte[]> { Subrecord("HEDR", hedr) };
        foreach (var master in masters)
        {
            subrecords.Add(Subrecord("MAST", Encoding.UTF8.GetBytes(master + "\0")));
            subrecords.Add(Subrecord("DATA", new byte[8]));
        }
        return Record("TES4", 0, light ? LightFlag : 0, Fallout4FormVersion, [.. subrecords]);
    }

    public static byte[] Plugin(byte[] tes4, params byte[][] groups) => Concat([tes4, .. groups]);

    public static byte[] Concat(params byte[][] parts) => parts.SelectMany(p => p).ToArray();

    private static byte[] RecordAroundPayload(string type, uint formId, uint flags, ushort formVersion, byte[] payload)
    {
        var bytes = new byte[HeaderLength + payload.Length];
        Encoding.ASCII.GetBytes(type).CopyTo(bytes, 0);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), (uint)payload.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(8), flags);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(12), formId);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(20), formVersion);
        payload.CopyTo(bytes, HeaderLength);
        return bytes;
    }
}
