using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.PluginAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Plugins;

public sealed class FailedReadStateTests : IDisposable
{
    private const string PluginName = "Rewritten.esp";

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("failed-read-state")
        .WithPlugin(PluginName, mod => mod.Npcs.AddNew("ReadAndFailedOn"))
        .Build();

    public void Dispose() => _fixture.Dispose();

    private string PluginPath => Path.Combine(_fixture.DataFolder, PluginName);

    [Fact]
    public void ABinaryRewrittenAfterItsReadFailed_IsReadAgain()
    {
        var adapter = new FailsOnceAfter(() =>
            PluginBinaries.Rewrite(PluginPath, mod => mod.Npcs.AddNew("WrittenAfterTheFailure")));

        using var index = Indexes.Reconciled(_fixture, adapter: adapter);

        Assert.DoesNotContain(index.Status.Failures, f => f.Name == PluginName);
        Assert.Contains(index.RequireReads().GetDocuments(_fixture.Plugins.Single().KeyOf()), d => d.EditorId == "WrittenAfterTheFailure");
    }

    private sealed class FailsOnceAfter(Action beforeFailing) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        private int _opened;

        public override IPluginDocuments OpenDocuments(
            ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas,
            PluginStrings? strings = null)
        {
            if (Interlocked.Increment(ref _opened) > 1) return base.OpenDocuments(modPath, gameRelease, schemas, strings);
            beforeFailing();
            throw new InvalidOperationException("injected read failure");
        }
    }
}
