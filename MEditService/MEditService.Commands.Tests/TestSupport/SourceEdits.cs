using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Commands.Tests.TestSupport;

public static class SourceEdits
{
    public static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    public static void Rewrite<T>(
        SourceRepository repository, PluginAddress plugin, RecordIdentity identity, GameRelease release, Action<T> change)
        where T : class, IMajorRecord
    {
        var located = repository.Get(plugin, identity).Require();
        var record = (T)TreeOf(repository, plugin, release).EnumerateMajorRecords()
            .Single(candidate => candidate.FormKey.ToString() == located.FormKey);
        change(record);
        Write(repository, plugin, record, identity.RecordType, release);
    }

    public static void Write(
        SourceRepository repository, PluginAddress plugin, IMajorRecordGetter record, string recordType, GameRelease release) =>
        repository.Put(plugin, new SourceDocument(
            record.FormKey.ToString(), recordType, record.EditorID,
            Codec.SerializeToText(record, release)));

    private static IMod TreeOf(SourceRepository repository, PluginAddress plugin, GameRelease release)
    {
        var files = SourceRepository.DoorFilesOf(plugin.Name, repository.FilesOf(plugin).Files, release);
        using var scratch = new ScratchDirectory("medit-source-edit-");
        foreach (var file in files)
        {
            var path = Path.Combine(scratch, file.RelativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(path) ?? scratch);
            File.WriteAllBytes(path, file.Content);
        }

        return RecordTextCodecGeneratorSeed.DeserializeWholeMod(
                PluginSourceRoot.In(scratch, plugin.Name), InlineWorkDropoff.Instance, CancellationToken.None)
            .GetAwaiter().GetResult();
    }
}
