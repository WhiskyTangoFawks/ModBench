using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A change to one record's document, made the way the source is made: read through the
/// codec, changed, written back through it. Any other text fails compile's round-trip gate.</summary>
public static class SourceEdits
{
    public static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    public static void Rewrite<T>(
        SourceRepository repository, PluginCopyKey plugin, RecordIdentity identity, GameRelease release, Action<T> change)
        where T : class, IMajorRecord
    {
        var body = repository.Get(plugin, identity).Require().Body;
        var record = (T)Codec.DeserializeFromBytes(Encoding.UTF8.GetBytes(body), release, identity.RecordType);
        change(record);
        Write(repository, plugin, record, identity.RecordType, release);
    }

    public static void Write(
        SourceRepository repository, PluginCopyKey plugin, IMajorRecordGetter record, string recordType, GameRelease release) =>
        repository.Put(plugin, new SourceDocument(
            record.FormKey.ToString(), recordType, record.EditorID,
            Encoding.UTF8.GetString(Codec.SerializeToBytes(record, release))));
}
