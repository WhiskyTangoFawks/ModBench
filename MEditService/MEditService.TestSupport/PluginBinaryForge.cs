using System.Buffers.Binary;
using System.Text;

namespace MEditService.TestSupport;

/// <summary>A fixture binary with subrecords removed from the only record of a type, as a tool
/// that loses them would leave it.</summary>
public static class PluginBinaryForge
{
    private const int HeaderLength = 24;

    public static byte[] WithoutSubrecords(byte[] original, string recordType, params string[] signatures)
    {
        var (recordStart, grupStart) = Locate(original, recordType);
        var dataStart = recordStart + HeaderLength;
        var dataLength = (int)BinaryPrimitives.ReadUInt32LittleEndian(original.AsSpan(recordStart + 4));

        var kept = new List<byte>();
        var removed = 0;
        var position = dataStart;
        while (position < dataStart + dataLength)
        {
            var length = 6 + BinaryPrimitives.ReadUInt16LittleEndian(original.AsSpan(position + 4));
            var signature = Encoding.ASCII.GetString(original, position, 4);
            if (signatures.Contains(signature)) removed += length;
            else kept.AddRange(original.AsSpan(position, length).ToArray());
            position += length;
        }

        var result = original[..dataStart].Concat(kept).Concat(original[(dataStart + dataLength)..]).ToArray();
        BinaryPrimitives.WriteUInt32LittleEndian(result.AsSpan(recordStart + 4), (uint)kept.Count);
        BinaryPrimitives.WriteUInt32LittleEndian(result.AsSpan(grupStart + 4),
            BinaryPrimitives.ReadUInt32LittleEndian(original.AsSpan(grupStart + 4)) - (uint)removed);
        return result;
    }

    private static (int RecordStart, int GrupStart) Locate(byte[] data, string recordType)
    {
        var grupStart = -1;
        var position = 0;
        while (position + HeaderLength <= data.Length)
        {
            var type = Encoding.ASCII.GetString(data, position, 4);
            if (type == "GRUP")
            {
                grupStart = position;
                position += HeaderLength;
                continue;
            }
            if (type == recordType) return (position, grupStart);
            position += HeaderLength + (int)BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(position + 4));
        }
        throw new InvalidOperationException($"No {recordType} record in the fixture binary.");
    }
}
