using MEditService.LoadOrder;

namespace MEditService.TestSupport;

/// <summary>An adapter's answer for a changed path as a test row spells it: the names of the plugins it touches, joined,
/// or "unnamed", or "untouched".</summary>
public static class PathAnswers
{
    public static string Spelled(PathAnswer answer) => answer switch
    {
        PathAnswer.Touches touches => string.Join(",", touches.Plugins.Select(plugin => plugin.Name)),
        PathAnswer.Unnamed => "unnamed",
        _ => "untouched",
    };
}
