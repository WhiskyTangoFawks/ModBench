namespace MEditService.Core.Records;

/// <summary>The three facts a <c>registrations</c> row carries (ADR-0044). Mod Management computes
/// all three; nothing here is derived except the two predicates below, which are the only
/// definition of participation and load-order membership.</summary>
public readonly record struct Registration(int? LoadOrderIndex, bool Enabled, bool Winning)
{
    /// <summary>Participation is derived, never stored (ADR-0044): only a participating copy
    /// competes for winner or counts in a conflict. "Overridden" and "disabled" are the same
    /// mechanism — a registered row that does not participate.</summary>
    public bool Participates => Enabled && Winning && LoadOrderIndex is not null;

    /// <summary>The winning copy of a listed name, enabled or not: a disabled line is still a
    /// legitimate write target; a losing copy is not (ADR-0036: editing a file the game does not
    /// load changes nothing).</summary>
    public bool InLoadOrder => Winning && LoadOrderIndex is not null;

    /// <summary>The winning, enabled copy of a listed name.</summary>
    public static Registration Participating(int slot) => new(slot, Enabled: true, Winning: true);

    /// <summary>The winning copy of a listed name whose line has no <c>*</c>.</summary>
    public static Registration Disabled(int slot) => new(slot, Enabled: false, Winning: true);

    /// <summary>A copy the Mod override order does not resolve the name to.</summary>
    public static Registration Losing(int? slot, bool enabled = true) => new(slot, enabled, Winning: false);
}
