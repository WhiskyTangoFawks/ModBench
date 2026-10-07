using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Plugins;

public sealed class ValidateAtLoadTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string NpcEditorId = "FixtureNpc";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _entry;
    private readonly string _formKey;

    public ValidateAtLoadTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("validate-at-load")
            .WithPlugin(PluginName, mod =>
            {
                npc = mod.Npcs.AddNew(NpcEditorId).FormKey;
                mod.Npcs.AddNew("UneditedNpc");
            }, origin: "FixtureMod")
            .BuildScattered()
            .Tracked();
        _entry = _fixture.Plugins.Single();
        _formKey = npc.ToString();
    }

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void AHandEditMadeWhileStopped_IsInTheLoadOrdersAnswer_WithoutReIndexingTheWholePlugin()
    {
        using (var first = Indexes.Reconciled(_fixture, _fixture.InstanceRoot))
        {
            _entry.HandEdit(
                first.RequireReads().DocumentOf(_formKey, _entry.KeyOf()), NpcEditorId, "EditedWhileStopped");
        }

        var holder = new LoadOrderHolder();
        var notifications = new InMemoryNotificationPublisher();
        using var restarted = Indexes.Open(holder, notifications: notifications);

        restarted.Reconcile(holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.Equal("EditedWhileStopped", restarted.RequireReads().DocumentOf(_formKey, _entry.KeyOf()).EditorId);
        Assert.Equal([_formKey], Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>()).Keys);
    }
}
