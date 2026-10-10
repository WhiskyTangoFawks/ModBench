using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
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
    private readonly List<LogEntry> _log = [];
    private readonly ILoggerFactory _loggerFactory;

    public ValidationFaultTests() =>
        _loggerFactory = LoggerFactory.Create(b => b.AddProvider(new CollectingLoggerProvider(_log)));

    public void Dispose()
    {
        _loggerFactory.Dispose();
        _fixture.Dispose();
    }

    private LoadOrderEntry Plugin => _fixture.Plugins.Single();

    private OpenedIndex Subscribed(INotificationPublisher? notifications = null)
    {
        var clock = new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1));
        var index = Indexes.Open(_holder, loggerFactory: _loggerFactory, notifications: notifications, timeProvider: clock);
        index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        return index;
    }

    private void RewriteThePlugin() =>
        PluginBinaries.Rewrite(Plugin.Path, mod => mod.Npcs.AddNew("WrittenByAnotherTool"));

    [Fact]
    public void AValidationThatFaultsOutright_ReachesTheOutput_AndFailsTheStatus()
    {
        using var index = Subscribed(notifications: new InMemoryNotificationPublisher { FaultsOn = n => n is PluginChangedNotification });
        RewriteThePlugin();

        index.NextSnapshotUntil(() => index.Status.State == LoadOrderState.Failed, "the failed status");

        lock (_log)
            Assert.Contains(_log, e => e.Level == LogLevel.Error && e.Exception?.Message == InMemoryNotificationPublisher.FaultReason);
        Assert.Contains(InMemoryNotificationPublisher.FaultReason, index.Status.Message, StringComparison.Ordinal);
    }
}
