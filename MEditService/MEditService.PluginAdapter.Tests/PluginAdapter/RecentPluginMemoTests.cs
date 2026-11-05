using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class RecentPluginMemoTests : IDisposable
{
    private readonly ScratchDirectory _folder = new("recent-plugin-memo");
    private readonly Dictionary<string, int> _reads = [];

    public void Dispose() => _folder.Dispose();

    private string Plugin(string name)
    {
        var path = Path.Combine(_folder.Path, name);
        File.WriteAllBytes(path, [1]);
        return path;
    }

    private void Ask(RecentPluginMemo<object> memo, string path) =>
        memo.Of(path, "", () =>
        {
            _reads[path] = _reads.GetValueOrDefault(path) + 1;
            return new object();
        });

    [Fact]
    public void ThePluginsLeastRecentlyAskedAbout_AreReadAgainOnceMoreThanTheTwoMostRecentAreAskedAbout()
    {
        var memo = new RecentPluginMemo<object>(new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1)), capacity: 2);
        var (first, second, third) = (Plugin("First.bin"), Plugin("Second.bin"), Plugin("Third.bin"));

        Ask(memo, first);
        Ask(memo, second);
        Ask(memo, third);
        Ask(memo, second);
        Ask(memo, first);
        Ask(memo, second);

        Assert.Equal([2, 1, 1], new[] { _reads[first], _reads[second], _reads[third] });
    }
}
