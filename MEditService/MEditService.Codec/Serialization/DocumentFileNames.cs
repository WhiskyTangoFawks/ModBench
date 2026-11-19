using System.Text;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization.Utility;

namespace MEditService.Codec.Serialization;

/// <summary>The file names of the whole-mod serializer's documents that more than one module reads, spelled once.</summary>
public static class DocumentFileNames
{
    /// <summary>A container's document, and the header's document at the plugin tree's root.</summary>
    public const string Root = "RecordData.json";

    // Linux holds a file name of at most 255 bytes and Windows 255 UTF-16 units, which no name of 255 UTF-8 bytes
    // exceeds. A longer name fails mid-write, naming a temp file instead of the record.
    private const int MostBytes = 255;

    /// <summary>Why the record cannot have a file or directory called <paramref name="name"/>; null when it can.</summary>
    public static string? WhyTooLong(string formKey, string? editorId, string name) =>
        Encoding.UTF8.GetByteCount(name) is var bytes and > MostBytes
            ? $"{formKey} cannot be written: its EditorID {editorId} makes a file name of {bytes} bytes, and a file name holds at most {MostBytes}."
            : null;

    /// <summary>Why a record of <paramref name="plugin"/> cannot have the file or directory the whole-mod serializer names
    /// it by; null when every one can.</summary>
    public static string? WhyTooLongIn(IModGetter plugin)
    {
        var types = RecordTypes.For(plugin.GameRelease);
        return plugin.EnumerateMajorRecords()
            .Select(record => WhyTooLong(record.FormKey.ToString(), record.EditorID, types.HasDirectory(types.RecordTypeOf(record))
                ? SerializationHelper.RecordNameProvider(record, number: null)
                : SerializationHelper.RecordFileNameProvider(record, Path.GetExtension(Root), number: null)))
            .FirstOrDefault(why => why is not null);
    }
}
