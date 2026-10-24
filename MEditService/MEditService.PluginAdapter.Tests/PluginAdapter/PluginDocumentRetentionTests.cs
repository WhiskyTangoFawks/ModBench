using System.Runtime.CompilerServices;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginDocumentRetentionTests
{
    private const string PluginName = "Retained.esp";
    private const int EditorIdLength = 60_000;
    private const int BatchCharacters = 16 * 1024 * 1024;

    private static readonly int RecordsPastABatchAndEveryRecordInFlightWhenItCloses =
        BatchCharacters / EditorIdLength + Environment.ProcessorCount + 2;

    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    [Fact]
    public void OpenDocuments_LetsGoOfADocumentItHasYielded_BeforeItReadsTheLast()
    {
        using var data = new PluginFixtureBuilder("documents-retention")
            .WithPlugin(PluginName, mod => AddNpcsWithLongEditorIds(mod, RecordsPastABatchAndEveryRecordInFlightWhenItCloses))
            .Build();
        using var documents = TestAdapters.Mutagen().OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), Path.Combine(data.DataFolder, PluginName)), EmptyLoadOrder.Of(GameRelease.Fallout4), Schemas, PluginStrings.None).Answered();

        Assert.False(FirstIsHeldWhenTheLastIsRead(documents.Records));
    }

    private static void AddNpcsWithLongEditorIds(Fallout4Mod mod, int count)
    {
        for (var i = 0; i < count; i++) mod.Npcs.AddNew($"{i:D5}{new string('E', EditorIdLength - 5)}");
    }

    private static bool FirstIsHeldWhenTheLastIsRead(IEnumerable<PluginDocument> documents)
    {
        using var reading = documents.GetEnumerator();
        var first = WeaklyTheFirst(reading);
        var read = 1;
        while (read < RecordsPastABatchAndEveryRecordInFlightWhenItCloses && reading.MoveNext()) read++;
        Assert.Equal(RecordsPastABatchAndEveryRecordInFlightWhenItCloses, read);
        return IsHeld(first);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference WeaklyTheFirst(IEnumerator<PluginDocument> reading)
    {
        Assert.True(reading.MoveNext());
        return new WeakReference(reading.Current);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static bool IsHeld(WeakReference weak)
    {
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        return weak.IsAlive;
    }
}
