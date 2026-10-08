using MEditService.Codec.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Edits;

/// <summary>xEdit's GetCanBePartial: the type declares the flag; a temporary exterior cell never can;
/// where the game names one plugin, only a cell that plugin defines can.</summary>
internal static class CanBePartial
{
    internal static bool TypeDeclares(Type recordType) => PartialFormFlag.IsPartialFormable(recordType);

    /// <summary>The verdict on the cell <paramref name="formKey"/>, which is a temporary exterior cell
    /// when <paramref name="temporaryExterior"/>.</summary>
    internal static Verdict OfCell(string? formKey, GameRelease release, bool temporaryExterior)
    {
        if (temporaryExterior) return new Verdict.TemporaryExterior();
        return PartialFormFlag.CellsDefinedIn(release) is { } only && FormKey.TryFactory(formKey, out var key) && key.ModKey != only
            ? new Verdict.DefinedElsewhere(key.ModKey, only)
            : new Verdict.Can();
    }

    internal abstract record Verdict
    {
        private Verdict()
        {
        }

        internal sealed record Can : Verdict;

        internal sealed record TemporaryExterior : Verdict;

        internal sealed record DefinedElsewhere(ModKey DefinedBy, ModKey Only) : Verdict;
    }
}
