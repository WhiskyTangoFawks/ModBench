using System.Buffers.Binary;
using System.Text;
using Mutagen.Bethesda.Plugins.Binary.Headers;
using Noggog;

namespace MEditService.PluginAdapter.Repair;

/// <summary>A subrecord as the repair engine reads and writes it.</summary>
internal readonly record struct Subrecord(string Signature, ReadOnlyMemorySlice<byte> Payload)
{
    private const int HeaderLength = 6;
    private const string Overflow = "XXXX";

    internal static Subrecord Of(SubrecordPinFrame frame) => new(frame.RecordType.Type, frame.Content);

    internal static Subrecord Zeroed(string signature, int length) => new(signature, new byte[length]);

    /// <summary>Its length as written, an <c>XXXX</c> overflow header included.</summary>
    internal int TotalLength => HeaderLength + Payload.Length + (Payload.Length > ushort.MaxValue ? HeaderLength + sizeof(uint) : 0);

    internal bool SameAs(Subrecord other) =>
        Signature == other.Signature && Payload.Span.SequenceEqual(other.Payload.Span);

    internal void WriteTo(Stream stream)
    {
        if (Payload.Length > ushort.MaxValue)
        {
            WriteHeader(stream, Overflow, sizeof(uint));
            Span<byte> length = stackalloc byte[sizeof(uint)];
            BinaryPrimitives.WriteUInt32LittleEndian(length, (uint)Payload.Length);
            stream.Write(length);
        }
        WriteHeader(stream, Signature, (ushort)(Payload.Length > ushort.MaxValue ? 0 : Payload.Length));
        stream.Write(Payload.Span);
    }

    private static void WriteHeader(Stream stream, string signature, ushort length)
    {
        Span<byte> header = stackalloc byte[HeaderLength];
        Encoding.ASCII.GetBytes(signature, header);
        BinaryPrimitives.WriteUInt16LittleEndian(header[4..], length);
        stream.Write(header);
    }
}
