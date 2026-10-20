import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import TrelloChatbotSettings from './TrelloChatbotSettings';
import { NotificationSettings } from './NotificationSettings';
import { AISettings } from './AISettings';
import { GmailDeliverySettings } from './GmailDeliverySettings';
import { HaiConnectorSettings } from './HaiConnectorSettings';

export function IntegrationAutomationSection() {
  const [activeTab, setActiveTab] = useState(() => new URLSearchParams(window.location.search).has('gmailDelivery') ? 'gmail' : 'trello');

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid h-auto w-full grid-cols-2 sm:grid-cols-5">
              <TabsTrigger value="trello">Trello Chatbot</TabsTrigger>
              <TabsTrigger value="notifications">Notifications</TabsTrigger>
              <TabsTrigger value="gmail">Gmail delivery</TabsTrigger>
              <TabsTrigger value="ai">AI & Models</TabsTrigger>
              <TabsTrigger value="hai">HAI</TabsTrigger>
            </TabsList>

            <TabsContent value="trello" className="space-y-4 mt-4">
              <TrelloChatbotSettings />
            </TabsContent>

            <TabsContent value="notifications" className="space-y-4 mt-4">
              <NotificationSettings />
            </TabsContent>

            <TabsContent value="gmail" className="space-y-4 mt-4">
              <GmailDeliverySettings />
            </TabsContent>

            <TabsContent value="ai" className="space-y-4 mt-4">
              <AISettings />
            </TabsContent>

            <TabsContent value="hai" className="space-y-4 mt-4">
              <HaiConnectorSettings />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
