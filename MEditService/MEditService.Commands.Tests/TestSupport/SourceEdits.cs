using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Commands.Tests.TestSupport;

public static class SourceEdits
{

    public static void Rewrite<T>(
        SourceRepository repository, PluginAddress plugin, RecordIdentity identity, GameRelease release, Action<T> change)
        where T : class, IMajorRecord
    {
        var located = repository.RecordOf(plugin, identity).Value().Require();
        var record = (T)TreeOf(repository, plugin).EnumerateMajorRecords()
            .Single(candidate => candidate.FormKey.ToString() == located.FormKey);
        change(record);
        Write(repository, plugin, record, identity.RecordType, release);
    }

    public static void Write(
        SourceRepository repository, PluginAddress plugin, IMajorRecordGetter record, string recordType, GameRelease release) =>
        repository.Put(plugin, new SourceDocument(
            record.FormKey.ToString(), recordType, record.EditorID,
            RecordTextCodec.SerializeToText(record, release))).Wrote();

    private static IMod TreeOf(SourceRepository repository, PluginAddress plugin)
    {
        var files = repository.TreeOf(plugin).Value().Files;
        using var scratch = new ScratchDirectory("medit-source-edit-");
        foreach (var file in files)
        {
            var path = Path.Combine(scratch, file.RelativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(path) ?? scratch);
            File.WriteAllBytes(path, file.Content);
        }

        return RecordTextCodecGeneratorSeed.DeserializeWholeMod(
                scratch, InlineWorkDropoff.Instance, CancellationToken.None)
            .GetAwaiter().GetResult();
    }
}
