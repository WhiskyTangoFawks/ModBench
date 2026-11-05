using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class ValidatingStatusTests : IDisposable
{
    private readonly PluginFixtureData _fixture;
    private readonly LoadOrderHolder _holder = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly OpenedIndex _index;

    public ValidatingStatusTests()
    {
        _fixture = new PluginFixtureBuilder("validating-status").WithPlugin("Named.esp").Build();
        _index = Indexes.Open(_holder, notifications: _notifications);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private IEnumerable<LoadOrderStatus> StatusesSince(int count) =>
        _notifications.Notifications.Skip(count).OfType<LoadOrderStatusNotification>().Select(n => n.Status);

    private void AssertValidatingOnceAsked_AndNotOnceDone(Action signal)
    {
        var before = _notifications.Notifications.Count;

        signal();

        Waits.Reached(() => StatusesSince(before).Any(status => status.Validating), "a validating status");
        Waits.Reached(() => !_index.Status.Validating && !StatusesSince(before).Last().Validating, "the validation closing");
        Assert.Equal(LoadOrderState.Ready, _index.Status.State);
    }

    [Fact]
    public void AChangeNamingAPluginThatMovedNothing_PublishesAValidatingStatus_ThenOneThatIsNot() =>
        AssertValidatingOnceAsked_AndNotOnceDone(() => _index.SignalChange([_fixture.Plugins.Single().Key]));

    [Fact]
    public void ACheckOfTheWholeDisk_PublishesAValidatingStatus_ThenOneThatIsNot() =>
        AssertValidatingOnceAsked_AndNotOnceDone(() => _index.SignalChange());

    [Fact]
    public void WithNoChangeAsked_NoStatusIsValidating()
    {
        Assert.False(_index.Status.Validating);
        Assert.DoesNotContain(StatusesSince(0), status => status.Validating);
    }
}
