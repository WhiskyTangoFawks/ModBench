using System.Runtime.CompilerServices;
using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
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
        var count = RecordsPastABatchAndEveryRecordInFlightWhenItCloses;
        using var data = new PluginFixtureBuilder("documents-retention")
            .WithPlugin(PluginName, mod =>
            {
                for (var i = 0; i < count; i++) mod.Npcs.AddNew($"{i:D5}{new string('E', EditorIdLength - 5)}");
            })
            .Build();
        using var documents = TestAdapters.Mutagen().OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), Path.Combine(data.DataFolder, PluginName)), GameRelease.Fallout4, Schemas).Answered();

        var first = new WeakReference(null);
        bool? firstHeldAtTheLast = null;
        var read = 0;
        foreach (var document in documents.Records)
        {
            if (read == 0) first.Target = document;
            if (++read == count) firstHeldAtTheLast = IsHeld(first);
        }

        Assert.False(firstHeldAtTheLast);
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
