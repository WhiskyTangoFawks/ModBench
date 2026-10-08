using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;

namespace MEditService.TestSupport;

/// <summary>Plugin bytes laid out by hand, so a fixture can carry a shape Mutagen would never write.</summary>
public static class RawPlugin
{
    public const uint MasterFlag = 0x1;
    public const uint LightFlag = 0x200;
    public const uint CompressedFlag = 0x40000;
    public const ushort Fallout4FormVersion = 131;

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
        RecordOf(type, formId, flags, formVersion, Concat(subrecords));

    public static byte[] DeflatedRecord(
        string type, uint formId, CompressionLevel level, params byte[][] subrecords)
    {
        var data = Concat(subrecords);
        using var payload = new MemoryStream();
        payload.Write(BitConverter.GetBytes((uint)data.Length));
        using (var zlib = new ZLibStream(payload, level, leaveOpen: true))
            zlib.Write(data);
        return RecordOf(type, formId, CompressedFlag, Fallout4FormVersion, payload.ToArray());
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
        return Record("TES4", 0, MasterFlag | (light ? LightFlag : 0), Fallout4FormVersion, [.. subrecords]);
    }

    public static byte[] Plugin(byte[] tes4, params byte[][] groups) => Concat([tes4, .. groups]);

    private static byte[] RecordOf(string type, uint formId, uint flags, ushort formVersion, byte[] data)
    {
        var bytes = new byte[HeaderLength + data.Length];
        Encoding.ASCII.GetBytes(type).CopyTo(bytes, 0);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), (uint)data.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(8), flags);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(12), formId);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(20), formVersion);
        data.CopyTo(bytes, HeaderLength);
        return bytes;
    }

    private static byte[] Concat(byte[][] parts) => parts.SelectMany(p => p).ToArray();
}
