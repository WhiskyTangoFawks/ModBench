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

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class LandingFaultTests : IDisposable
{
    private const string Kept = "Kept.esp";
    private const string Thrown = "Thrown.esp";
    private const string ItsOwnFault = "Thrown.esp's documents could not be read";

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("landing-fault")
        .WithPlugin(Kept, mod => mod.Npcs.AddNew("7"))
        .WithPlugin(Thrown, mod => mod.Npcs.AddNew("ThrownNpc"))
        .Build();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void APluginWhoseReadThrows_IsReportedWithItsOwnFault_ThoughTheFilterReapplyLandingItThrowsToo()
    {
        var holder = new LoadOrderHolder();
        var notifications = new InMemoryNotificationPublisher { FaultsOn = n => n is RecordFilterClearedNotification };
        using var index = Indexes.Open(holder, new FaultingTheFilterThenThrowing(_fixture.InstanceRoot), notifications: notifications);
        index.Reconcile(holder, _fixture.DataFolder, [.. _fixture.Plugins.Where(p => p.Name == Kept)], GameRelease.Fallout4, _fixture.InstanceRoot);
        index.SetFilter("SELECT form_key FROM npc_ WHERE CAST(editor_id AS INTEGER) = 7", "filter.sql");

        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

        var reported = notifications.Notifications.OfType<LoadOrderStatusNotification>()
            .SelectMany(n => n.Status.Failures).Where(f => f.Name == Thrown).Select(f => f.Reason).Distinct().ToList();
        Assert.NotEmpty(reported);
        Assert.All(reported, reason => Assert.Contains(ItsOwnFault, reason, StringComparison.Ordinal));
    }

    private sealed class FaultingTheFilterThenThrowing(string instanceRoot) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
            ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas,
            PluginStrings strings) =>
            modPath.ModKey.FileName == Thrown
                ? RequireExtensions.AnswerOf<IPluginDocuments>(() => new KeptNpcRenamedThenThrown(instanceRoot))
                : base.OpenDocuments(modPath, loadOrder, schemas, strings);
    }

    private sealed class KeptNpcRenamedThenThrown(string instanceRoot) : IPluginDocuments
    {
        public PluginDocument Header => new("header", $"000000:{Thrown}", "{}");

        public IReadOnlyList<RecordTypeFailure> Failures => [];

        public IEnumerable<PluginDocument> Records
        {
            get
            {
                IndexFiles.Execute(instanceRoot, $"UPDATE mirror.records SET editor_id = 'NotANumber' WHERE plugin = '{Kept}'");
                throw new InvalidDataException(ItsOwnFault);
            }
        }

        public void Dispose()
        {
        }
    }
}
