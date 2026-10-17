using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

using static MEditService.RecordIndex.Tests.TestSupport.Announcements;

namespace MEditService.RecordIndex.Tests.Indexing;

public sealed class ReReadMemoryTests : IDisposable
{
    private const string Plugin = "Referring.esp";
    private const int RecordCount = 40_000;
    private const int ReferencesPerRecord = 50;
    private const string MemoryLimit = "96MB";

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("re-read-memory").WithPlugin(Plugin).Build();
    private readonly LoadOrderHolder _holder = new();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void APluginWhoseReferencesOutgrowDuckDbsMemoryLimit_IsReadAndReadAgainWhole()
    {
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Open(_holder, new ReferringAdapter(_fixture.InstanceRoot), notifications: notifications);
        index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        Assert.Equal((LoadOrderState.Ready, null, ""), Answer(index));

        var before = notifications.Notifications.Count;
        var readAgain = Touched(_fixture.Plugins.Single());
        index.NextSnapshotUntil(
            () => notifications.Since(before).Any(n => readAgain(n) || FailureNamed(Plugin)(n) || n is LoadOrderStatusNotification { Status.State: LoadOrderState.Failed }),
            "the plugin read again");

        Assert.Equal((LoadOrderState.Ready, null, ""), Answer(index));
        Assert.Equal(ReferencesPerRecord, index.Queries.GetReferences(Target(0)).Value().Count);
    }

    private static (LoadOrderState, string?, string) Answer(OpenedIndex index) =>
        (index.Status.State, index.Status.Message, string.Join("; ", index.Status.Failures.Select(f => f.Reason)));

    private static string Target(int i) => $"{0x800 + i:X6}:{Plugin}";

    private sealed class ReferringAdapter(string instanceRoot) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
            ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas,
            PluginStrings? strings = null) =>
            RequireExtensions.AnswerOf<IPluginDocuments>(() => new ReferringRecords(instanceRoot));
    }

    private sealed class ReferringRecords(string instanceRoot) : IPluginDocuments
    {
        public PluginDocument Header => new("header", $"000000:{Plugin}", "{}");

        public IReadOnlyList<RecordTypeFailure> Failures => [];

        public IEnumerable<PluginDocument> Records
        {
            get
            {
                LimitDuckDbsMemory();
                for (var i = 0; i < RecordCount; i++)
                {
                    var formKey = $"{0x800 + RecordCount + i:X6}:{Plugin}";
                    var keywords = string.Join(", ", Enumerable.Range(0, ReferencesPerRecord).Select(j => $"\"{Target((i + j * 7919) % RecordCount)}\""));
                    yield return new PluginDocument("npc_", formKey, $$"""{"FormKey": "{{formKey}}", "Keywords": [{{keywords}}]}""");
                }
            }
        }

        private void LimitDuckDbsMemory()
        {
            IndexFiles.Execute(instanceRoot, $"SET GLOBAL memory_limit = '{MemoryLimit}'");
        }

        public void Dispose()
        {
        }
    }
}
