using System.Runtime.CompilerServices;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;
using static MEditService.TestSupport.RawPlugin;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class RecentPluginMemoTests : IDisposable
{
    private readonly PluginFixtureData _data = new PluginFixtureBuilder("adapter-recent-plugin-memo").Build();
    private readonly MutagenPluginAdapter _adapter = new(new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1)));

    public void Dispose() => _data.Dispose();

    private RegisteredPlugin Plugin(string name)
    {
        var path = Path.Combine(_data.DataFolder, name);
        File.WriteAllBytes(path, RawPlugin.Plugin(Tes4(), Group("MISC", Misc(0x800, name))));
        return new RegisteredPlugin(name, PluginOrigin.DataDirectory, path, PluginProvider.Game, Line: null, PluginStrings.None);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private WeakReference Ask(RegisteredPlugin plugin)
    {
        var loadOrder = EmptyLoadOrder.Of(GameRelease.Fallout4);
        using var records = _adapter.OpenRecordLookup(
            plugin, loadOrder, SharedSchemaReflector.Instance.GetSchemas(loadOrder.GameRelease)).Answered();
        return new WeakReference(records.IdentityOf($"000800:{plugin.Name}").Answered()?.EditorId);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static bool IsHeld(WeakReference weak)
    {
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        return weak.IsAlive;
    }

    [Fact]
    public void APluginAskedAboutBeforeTwoOthers_IsLetGoOf()
    {
        var (first, second, third) = (Plugin("First.esp"), Plugin("Second.esp"), Plugin("Third.esp"));
        var editorId = Ask(first);
        Ask(second);
        Ask(third);

        Assert.False(IsHeld(editorId));
    }

    [Fact]
    public void APluginAskedAboutBeforeOneOther_IsHeld()
    {
        var (first, second) = (Plugin("First.esp"), Plugin("Second.esp"));
        var held = Ask(first);
        Ask(second);

        Assert.True(IsHeld(held));
    }

    [Fact]
    public void APluginAskedAboutAgain_OutlastsOneAskedAboutBeforeIt()
    {
        var (first, second, third) = (Plugin("First.esp"), Plugin("Second.esp"), Plugin("Third.esp"));
        Ask(first);
        Ask(second);
        var held = Ask(first);
        Ask(third);

        Assert.True(IsHeld(held));
    }
}
