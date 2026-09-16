namespace MEditService.LoadOrder;

/// <summary>A plugin named without an origin (ADR-0012): the filter position that means any copy
/// of that name. Never a row, lookup or command target — those take <see cref="PluginCopyKey"/>.
/// </summary>
public readonly record struct PluginName(string Name)
{
    public static implicit operator PluginName(string name) => new(name);
}
