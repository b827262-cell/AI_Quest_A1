import { FeatureStrip } from "./public-home/FeatureStrip";
import { PublicHero } from "./public-home/PublicHero";
import { PublicHomeFooter } from "./public-home/PublicHomeFooter";
import { PublicHomeHeader } from "./public-home/PublicHomeHeader";
import { useGuestQuestion } from "./public-home/useGuestQuestion";
import { useLearningHistorySync } from "./public-home/useLearningHistorySync";
import { usePublicSiteConfig } from "./public-home/usePublicSiteConfig";
import { useShareIntake } from "./public-home/useShareIntake";

export function PublicHomePage() {
  const history = useLearningHistorySync();
  const config = usePublicSiteConfig();
  const intake = useShareIntake(history.setLearningHistory);
  const guest = useGuestQuestion({
    config,
    setLearningHistory: history.setLearningHistory,
    setGoogleStatus: intake.setGoogleStatus
  });

  return (
    <div className="public-home-page">
      <PublicHomeHeader config={config} studentName={history.studentName} />
      <main className="public-home-main">
        {config.maintenanceNotice ? <div className="public-maintenance-notice">{config.maintenanceNotice}</div> : null}
        <PublicHero config={config} history={history} intake={intake} guest={guest} />
        <FeatureStrip />
      </main>
      <PublicHomeFooter />
    </div>
  );
}
