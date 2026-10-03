using MEditService.LoadOrder;

namespace MEditService.TestSupport;

/// <summary>A fixture's plugin as Mod Management knows it. The fixture stands in for Mod Management,
/// which alone decides the active plugins from these facts (ADR-0013).</summary>
public record LoadOrderEntry(
    string Name, string Path, string Origin, int? Slot, bool Enabled, bool Winning, bool LoadedWithNoLine = false)
{
    public PluginAddress Key => new(Name, Origin);
}
