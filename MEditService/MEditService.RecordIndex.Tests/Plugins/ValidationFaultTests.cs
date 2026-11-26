using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class ValidationFaultTests : IDisposable
{
    private const string PluginName = "NonCompiledPlugin.esp";

    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("validation-fault")
        .WithPlugin(PluginName, mod => mod.Npcs.AddNew("NonCompiledPluginNpc"), origin: "NonSourceMod")
        .BuildScattered();
    private readonly LoadOrderHolder _holder = new();
    private readonly List<LogEntry> _log = [];
    private readonly ILoggerFactory _loggerFactory;
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly OpenedIndex _index;

    public ValidationFaultTests()
    {
        _loggerFactory = LoggerFactory.Create(b => b.AddProvider(new CollectingLoggerProvider(_log)));
        var clock = new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1));
        _index = Indexes.Open(_holder, loggerFactory: _loggerFactory, notifications: _notifications, timeProvider: clock);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
    }

    public void Dispose()
    {
        _index.Dispose();
        _loggerFactory.Dispose();
        _fixture.Dispose();
    }

    private LoadOrderEntry Plugin => _fixture.Plugins.Single();

    private static bool IsPluginChanged(INotification notification) => notification is PluginChangedNotification;

    private void RewriteThePlugin(string editorId) =>
        PluginBinaries.Rewrite(Plugin.Path, mod => mod.Npcs.AddNew(editorId));

    private void ACheckFailed()
    {
        RewriteThePlugin("WrittenByAnotherTool");
        _index.NextCheckThatMayFailUntil(() => _index.Status.State == LoadOrderState.Failed, "the failed status");
    }

    [Theory]
    [InlineData(typeof(InvalidOperationException))]
    [InlineData(typeof(OutOfMemoryException))]
    [InlineData(typeof(OperationCanceledException))]
    public void AValidationThatFaultsOutright_ReachesTheOutput_AndFailsTheStatus(Type thrownType)
    {
        var thrown = Faults.Of(thrownType);
        _notifications.OnPublish = Faults.On(IsPluginChanged, thrown);

        ACheckFailed();

        lock (_log)
            Assert.Contains(_log, e => e.Level == LogLevel.Error && e.Exception?.Message == thrown.Message);
        Assert.Contains(thrown.Message, _index.Status.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AFailedStatusWhosePublishFaults_IsPublishedOnceItCan()
    {
        var statusFault = Faults.InTurn(typeof(NotSupportedException));
        _notifications.OnPublish = Faults.On(IsPluginChanged, Faults.Of(typeof(InvalidOperationException)))
            + (notification => { if (notification is LoadOrderStatusNotification { Status.State: LoadOrderState.Failed }) statusFault(); });

        RewriteThePlugin("WrittenByAnotherTool");
        _index.SignalChange();

        Waits.Reached(
            () => _notifications.Notifications.OfType<LoadOrderStatusNotification>().Any(n => n.Status.State == LoadOrderState.Failed),
            "the failed status published");
    }

    [Fact]
    public void ACheckThatValidatesCleanly_ClearsTheFailureAnEarlierCheckSet()
    {
        _notifications.FaultsOn = IsPluginChanged;
        ACheckFailed();

        _notifications.FaultsOn = null;
        RewriteThePlugin("WrittenAgainByAnotherTool");

        _index.NextCheckUntil(
            () => _index.ListedIn(Plugin.Key).Any(row => row.EditorId == "WrittenAgainByAnotherTool"), "the second rewrite read");
        Assert.Equal(LoadOrderState.Ready, _index.Status.State);
    }
}
