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

    public static byte[] U32(uint value)
    {
        var bytes = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(bytes, value);
        return bytes;
    }

    public static byte[] EditorId(string editorId) => Subrecord("EDID", Encoding.ASCII.GetBytes(editorId + "\0"));

    public static byte[] Misc(uint formId, string editorId) => Record("MISC", formId, EditorId(editorId));

    public static uint NewRecordId(int masterCount, uint objectId) => ((uint)masterCount << 24) | objectId;

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

    public static byte[] FirstMiscZlibHeader(byte[] plugin)
    {
        var group = HeaderLength + (int)BinaryPrimitives.ReadUInt32LittleEndian(plugin.AsSpan(4));
        Assert.Equal("GRUP"u8.ToArray(), plugin[group..(group + 4)]);
        Assert.Equal("MISC"u8.ToArray(), plugin[(group + 8)..(group + 12)]);
        var record = group + HeaderLength;
        var flags = BinaryPrimitives.ReadUInt32LittleEndian(plugin.AsSpan(record + 8));
        Assert.NotEqual(0u, flags & (uint)CompressedFlag.Bit);
        return plugin[(record + HeaderLength + sizeof(uint))..(record + HeaderLength + sizeof(uint) + 2)];
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

    /// <summary>The plugin with the subrecords of its uncompressed record <paramref name="formId"/> as
    /// <paramref name="edit"/> makes them, and every group around the record resized.</summary>
    public static byte[] EditRecord(
        byte[] plugin, uint formId, Func<List<(string Signature, byte[] Payload)>, IEnumerable<(string Signature, byte[] Payload)>> edit)
    {
        var openGroups = new Stack<(int Start, int End)>();
        for (var at = 0; at < plugin.Length;)
        {
            while (openGroups.TryPeek(out var group) && group.End <= at) openGroups.Pop();
            var type = Encoding.ASCII.GetString(plugin, at, 4);
            var size = (int)BinaryPrimitives.ReadUInt32LittleEndian(plugin.AsSpan(at + 4));
            if (type == "GRUP")
            {
                openGroups.Push((at, at + size));
                at += HeaderLength;
                continue;
            }
            var end = at + HeaderLength + size;
            if (type == "TES4" || BinaryPrimitives.ReadUInt32LittleEndian(plugin.AsSpan(at + 12)) != formId)
            {
                at = end;
                continue;
            }

            var subrecords = new List<(string, byte[])>();
            for (var sub = at + HeaderLength; sub < end;)
            {
                var length = BinaryPrimitives.ReadUInt16LittleEndian(plugin.AsSpan(sub + 4));
                subrecords.Add((Encoding.ASCII.GetString(plugin, sub, 4), plugin[(sub + 6)..(sub + 6 + length)]));
                sub += 6 + length;
            }
            var record = Concat([plugin[at..(at + HeaderLength)], .. edit(subrecords).Select(s => Subrecord(s.Signature, s.Payload))]);
            BinaryPrimitives.WriteUInt32LittleEndian(record.AsSpan(4), (uint)(record.Length - HeaderLength));

            var edited = Concat(plugin[..at], record, plugin[end..]);
            foreach (var (start, _) in openGroups)
            {
                var groupSize = BinaryPrimitives.ReadUInt32LittleEndian(edited.AsSpan(start + 4));
                BinaryPrimitives.WriteUInt32LittleEndian(edited.AsSpan(start + 4), (uint)(groupSize + record.Length - (end - at)));
            }
            return edited;
        }
        throw new InvalidOperationException($"The plugin holds no record {formId:X8}.");
    }

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
