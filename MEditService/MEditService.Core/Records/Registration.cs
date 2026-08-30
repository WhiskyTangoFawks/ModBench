namespace MEditService.Core.Records;

/// <summary>
/// What the load order says about one physical plugin copy — the three facts a
/// <c>registrations</c> row carries (ADR-0044). Mod Management computes all three and sends them
/// whole; nothing here is ever derived on this side of the boundary except the two predicates
/// below, which are the <i>only</i> definition of participation and load-order membership.
/// </summary>
/// <param name="LoadOrderIndex">The name's <c>plugins.txt</c> slot; null when no line names it.
/// A losing copy of a listed name carries the same slot as the winning one, so the two land
/// adjacent in the compare grid.</param>
/// <param name="Enabled">The line's <c>*</c> prefix.</param>
/// <param name="Winning">This copy is the one the Mod override order resolves the name to.</param>
public readonly record struct Registration(int? LoadOrderIndex, bool Enabled, bool Winning)
{
    /// <summary>Participation is derived, never stored (ADR-0044): only a participating copy
    /// competes for winner or counts in a conflict. "Overridden" and "disabled" are the same
    /// mechanism — a registered row that does not participate.</summary>
    public bool Participates => Enabled && Winning && LoadOrderIndex is not null;

    /// <summary>Whether the load order names this copy — the winning copy of a listed name, enabled
    /// or not. A disabled line is still in the load order and still a legitimate write target; a
    /// losing copy is not, whatever its line says (ADR-0036: editing a file the game does not load
    /// changes nothing anywhere).</summary>
    public bool InLoadOrder => Winning && LoadOrderIndex is not null;

    /// <summary>The winning, enabled copy of a listed name.</summary>
    public static Registration Participating(int slot) => new(slot, Enabled: true, Winning: true);

    /// <summary>The winning copy of a listed name whose line has no <c>*</c>.</summary>
    public static Registration Disabled(int slot) => new(slot, Enabled: false, Winning: true);

    /// <summary>A copy the Mod override order does not resolve the name to.</summary>
    public static Registration Losing(int? slot, bool enabled = true) => new(slot, enabled, Winning: false);
}
