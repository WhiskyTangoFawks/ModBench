using System.Reflection;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Watcher.Tests.Bridge;

/// <summary>ADR-0013 invariant 4: one load order, the kernel's. The watcher reads it from the holder
/// and holds only the Index surface that answers nothing about it.</summary>
public sealed class WatcherAsksTheIndexNoLoadOrderTests
{
    private static IReadOnlyList<Type> WatcherDependencies() =>
        [.. typeof(ModFolderWatcher).GetConstructors().Single().GetParameters().Select(p => p.ParameterType)];

    [Fact]
    public void TheWatcher_ReadsTheLoadOrderFromTheHolder()
    {
        Assert.Contains(typeof(LoadOrderHolder), WatcherDependencies());
    }

    // IRefreshIndex is the whole of what the watcher can ask the Index, and
    // ArchitectureTests.TheIndexSurface_HandsOutNoLoadOrder is what keeps a load order off it. Take
    // the projector or the store instead and that guard is bypassed.
    [Fact]
    public void TheWatcher_TakesTheRefreshSurface_AndNoOtherIndexType()
    {
        var indexTypes = WatcherDependencies()
            .Where(t => t.Namespace == typeof(IRefreshIndex).Namespace)
            .ToList();

        Assert.Equal([typeof(IRefreshIndex)], indexTypes);
    }

    // A member the watcher never calls is a widening nobody asked for, and every implementer — the
    // projector and each test's recorder alike — pays for it.
    [Fact]
    public void TheRefreshSurface_HoldsOnlyMembersTheWatcherCalls()
    {
        var watcherSource = string.Concat(
            SourceTree.CSharpFiles(Path.Combine(RepoRoot.SolutionDirectory(), "MEditService.Watcher"))
                .Select(File.ReadAllText));

        var uncalled = typeof(IRefreshIndex).GetProperties().Select(m => m.Name)
            .Concat(typeof(IRefreshIndex).GetMethods().Where(m => !m.IsSpecialName).Select(m => m.Name))
            // Through the field, not the bare name: the watcher's own `_holder.Current` would
            // otherwise answer for a member only the holder has.
            .Where(name => !watcherSource.Contains($"_index.{name}", StringComparison.Ordinal))
            .ToList();

        Assert.True(uncalled.Count == 0,
            $"{nameof(IRefreshIndex)} carries members the watcher never calls:\n" + string.Join("\n", uncalled));
    }

    // The interface is subscribe and dispose: a public verb beyond those is a message something
    // outside would send it, and every settle is then a path a caller has to remember.
    [Fact]
    public void TheWatcher_TakesNoMessage_BeyondSubscribeAndDispose()
    {
        var verbs = typeof(ModFolderWatcher)
            .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            .Where(m => !m.IsSpecialName)
            .Select(m => m.Name)
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.Equal([nameof(IDisposable.Dispose), nameof(ModFolderWatcher.Subscribe)], verbs);
    }

    private const BindingFlags EveryMember =
        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;

    // The delegates the appliers hung their routing on: a public settable member of a delegate type
    // is how the routing leaves the box again.
    [Fact]
    public void TheWatcher_HandsOutNoRoutingDelegate()
    {
        var handles = typeof(ModFolderWatcher).GetMembers(EveryMember)
            .OfType<PropertyInfo>()
            .Where(p => typeof(Delegate).IsAssignableFrom(p.PropertyType))
            .Select(p => p.Name)
            .ToList();

        Assert.True(handles.Count == 0,
            "The watcher hands its routing back out as a delegate:\n" + string.Join("\n", handles));
    }
}
