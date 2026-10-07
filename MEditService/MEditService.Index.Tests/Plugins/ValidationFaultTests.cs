using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

public sealed class ValidationFaultTests : IDisposable
{
    private const string PluginName = "Untracked.esp";

    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("validation-fault")
        .WithPlugin(PluginName, mod => mod.Npcs.AddNew("UntrackedNpc"), origin: "UntrackedMod")
        .BuildScattered();
    private readonly LoadOrderHolder _holder = new();

    public void Dispose() => _fixture.Dispose();

    private LoadOrderEntry Plugin => _fixture.Plugins.Single();

    private OpenedIndex Subscribed(INotificationPublisher? notifications = null)
    {
        var clock = new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1));
        var index = Indexes.Open(_holder, notifications: notifications, timeProvider: clock);
        index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        return index;
    }

    private void RewriteThePlugin() =>
        PluginBinaries.Rewrite(Plugin.Path, mod => mod.Npcs.AddNew("WrittenByAnotherTool"));

    [Fact]
    public void AValidationThatFaultsOutright_FailsTheStatus_AndNamesTheFault()
    {
        using var index = Subscribed(notifications: new PluginChangedFaults());
        RewriteThePlugin();

        index.NextSnapshotUntil(() => index.Status.State == LoadOrderState.Failed, "the failed status");

        Assert.Contains(PluginChangedFaults.Reason, index.Status.Message, StringComparison.Ordinal);
    }

    private sealed class PluginChangedFaults : INotificationPublisher
    {
        public const string Reason = "the stream could not take the push";

        public void Publish(INotification notification)
        {
            if (notification is PluginChangedNotification) throw new InvalidOperationException(Reason);
        }
    }
}
